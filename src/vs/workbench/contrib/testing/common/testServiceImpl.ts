/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { groupBy } from 'vs/base/common/arrays';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { Emitter } from 'vs/base/common/event';
import { Iterable } from 'vs/base/common/iterator';
import { Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { isDefined } from 'vs/base/common/types';
import { URI, UriComponents } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { ExtHostTestingResource } from 'vs/workbench/api/common/extHost.protocol';
import { AbstractIncrementalTestCollection, collectTestResults, EMPTY_TEST_RESULT, getTestSubscriptionKey, IncrementalTestCollectionItem, InternalTestItem, RunTestsRequest, RunTestsResult, TestDiffOpType, TestIdWithProvider, TestsDiff } from 'vs/workbench/contrib/testing/common/testCollection';
import { TestingContextKeys } from 'vs/workbench/contrib/testing/common/testingContextKeys';
import { ITestService, MainTestController, TestDiffListener } from 'vs/workbench/contrib/testing/common/testService';

type TestLocationIdent = { resource: ExtHostTestingResource, uri: URI };

export class TestService extends Disposable implements ITestService {
	declare readonly _serviceBrand: undefined;
	private testControllers = new Map<string, MainTestController>();
	private readonly testSubscriptions = new Map<string, {
		collection: MainThreadTestCollection;
		stillDiscovering: number;
		ident: TestLocationIdent;
		onDiff: Emitter<TestsDiff>;
		listeners: number;
	}>();

	private readonly subscribeEmitter = new Emitter<TestLocationIdent>();
	private readonly unsubscribeEmitter = new Emitter<TestLocationIdent>();
	private readonly busyStateChangeEmitter = new Emitter<TestLocationIdent & { busy: boolean }>();
	private readonly changeProvidersEmitter = new Emitter<{ delta: number }>();
	private readonly providerCount: IContextKey<number>;
	private readonly isRunning: IContextKey<boolean>;
	private readonly runStartedEmitter = new Emitter<RunTestsRequest>();
	private readonly runCompletedEmitter = new Emitter<{ req: RunTestsRequest, result: RunTestsResult }>();
	private readonly runningTests = new Map<RunTestsRequest, CancellationTokenSource>();

	public readonly onTestRunStarted = this.runStartedEmitter.event;
	public readonly onTestRunCompleted = this.runCompletedEmitter.event;

	constructor(@IContextKeyService contextKeyService: IContextKeyService, @INotificationService private readonly notificationService: INotificationService) {
		super();
		this.providerCount = TestingContextKeys.providerCount.bindTo(contextKeyService);
		this.isRunning = TestingContextKeys.isRunning.bindTo(contextKeyService);
	}

	/**
	 * Gets currently running tests.
	 */
	public get testRuns() {
		return this.runningTests.keys();
	}

	/**
	 * Gets the current provider count.
	 */
	public get providers() {
		return this.providerCount.get() || 0;
	}

	/**
	 * Fired when extension hosts should pull events from their test factories.
	 */
	public readonly onShouldSubscribe = this.subscribeEmitter.event;

	/**
	 * Fired when extension hosts should stop pulling events from their test factories.
	 */
	public readonly onShouldUnsubscribe = this.unsubscribeEmitter.event;

	/**
	 * Fired when the number of providers change.
	 */
	public readonly onDidChangeProviders = this.changeProvidersEmitter.event;

	/**
	 * @inheritdoc
	 */
	public readonly onBusyStateChange = this.busyStateChangeEmitter.event;

	/**
	 * @inheritdoc
	 */
	public get subscriptions() {
		return [...this.testSubscriptions].map(([, s]) => s.ident);
	}

	/**
	 * @inheritdoc
	 */
	public cancelTestRun(req: RunTestsRequest) {
		this.runningTests.get(req)?.cancel();
	}

	/**
	 * @inheritdoc
	 */
	public get busyTestLocations() {
		return Iterable.map(Iterable.filter(this.testSubscriptions.values(), s => s.stillDiscovering > 0), s => s.ident);
	}

	/**
	 * @inheritdoc
	 */
	public async lookupTest(test: TestIdWithProvider) {
		return this.testControllers.get(test.providerId)?.lookupTest(test);
	}


	/**
	 * @inheritdoc
	 */
	public async runTests(req: RunTestsRequest, token = CancellationToken.None): Promise<RunTestsResult> {
		const tests = groupBy(req.tests, (a, b) => a.providerId === b.providerId ? 0 : 1);
		const cancelSource = new CancellationTokenSource(token);
		const requests = tests.map(group => {
			const providerId = group[0].providerId;
			const controller = this.testControllers.get(providerId);
			return controller?.runTests({ providerId, debug: req.debug, ids: group.map(t => t.testId) }, cancelSource.token).catch(err => {
				this.notificationService.error(localize('testError', 'An error occurred attempting to run tests: {0}', err.message));
				return EMPTY_TEST_RESULT;
			});
		}).filter(isDefined);

		if (requests.length === 0) {
			return EMPTY_TEST_RESULT;
		}

		this.runningTests.set(req, cancelSource);
		this.runStartedEmitter.fire(req);
		this.isRunning.set(true);

		const result = collectTestResults(await Promise.all(requests));

		this.runningTests.delete(req);
		this.runCompletedEmitter.fire({ req, result });
		this.isRunning.set(this.runningTests.size > 0);

		return result;
	}

	/**
	 * @inheritdoc
	 */
	public updateDiscoveringCount(resource: ExtHostTestingResource, uri: URI, delta: number) {
		const subscriptionKey = getTestSubscriptionKey(resource, uri);
		const subscription = this.testSubscriptions.get(subscriptionKey);
		if (!subscription) {
			return;
		}

		const wasBusy = !!subscription.stillDiscovering;
		subscription.stillDiscovering += delta;
		const isBusy = !!subscription.stillDiscovering;
		if (wasBusy !== isBusy) {
			this.busyStateChangeEmitter.fire({ resource, uri, busy: isBusy });
		}
	}

	/**
	 * @inheritdoc
	 */
	public resubscribeToAllTests() {
		for (const subscription of this.testSubscriptions.values()) {
			this.unsubscribeEmitter.fire(subscription.ident);
			const diff = subscription.collection.clear();
			subscription.onDiff.fire(diff);
			this.subscribeEmitter.fire(subscription.ident);
		}
	}

	/**
	 * @inheritdoc
	 */
	public subscribeToDiffs(resource: ExtHostTestingResource, uri: URI, acceptDiff: TestDiffListener) {
		const subscriptionKey = getTestSubscriptionKey(resource, uri);
		let subscription = this.testSubscriptions.get(subscriptionKey);
		if (!subscription) {
			subscription = {
				ident: { resource, uri },
				collection: new MainThreadTestCollection(),
				listeners: 0,
				onDiff: new Emitter(),
				stillDiscovering: 0,
			};
			this.subscribeEmitter.fire({ resource, uri });
			this.testSubscriptions.set(subscriptionKey, subscription);
		}

		subscription.listeners++;

		const revive = subscription.collection.getReviverDiff();
		if (revive.length) {
			acceptDiff(revive);
		}

		const listener = subscription.onDiff.event(acceptDiff);
		return toDisposable(() => {
			listener.dispose();

			if (!--subscription!.listeners) {
				this.unsubscribeEmitter.fire({ resource, uri });
				this.testSubscriptions.delete(subscriptionKey);
			}
		});
	}

	/**
	 * @inheritdoc
	 */
	public publishDiff(resource: ExtHostTestingResource, uri: UriComponents, diff: TestsDiff) {
		const sub = this.testSubscriptions.get(getTestSubscriptionKey(resource, URI.revive(uri)));
		if (sub) {
			sub.collection.apply(diff);
			sub.onDiff.fire(diff);
		}
	}

	/**
	 * @inheritdoc
	 */
	public registerTestController(id: string, controller: MainTestController): void {
		this.testControllers.set(id, controller);
		this.providerCount.set(this.testControllers.size);
		this.changeProvidersEmitter.fire({ delta: 1 });
	}

	/**
	 * @inheritdoc
	 */
	public unregisterTestController(id: string): void {
		this.testControllers.delete(id);
		this.providerCount.set(this.testControllers.size);
		this.changeProvidersEmitter.fire({ delta: -1 });
	}
}

class MainThreadTestCollection extends AbstractIncrementalTestCollection<IncrementalTestCollectionItem> {
	/**
	 * Gets a diff that adds all items currently in the tree to a new collection,
	 * allowing it to fully hydrate.
	 */
	public getReviverDiff() {
		const ops: TestsDiff = [];
		const queue = [this.roots];
		while (queue.length) {
			for (const child of queue.pop()!) {
				const item = this.items.get(child)!;
				ops.push([TestDiffOpType.Add, { id: item.id, providerId: item.providerId, item: item.item, parent: item.parent }]);
				queue.push(item.children);
			}
		}

		return ops;
	}

	/**
	 * Clears everything from the collection, and returns a diff that applies
	 * that action.
	 */
	public clear() {
		const ops: TestsDiff = [];
		for (const root of this.roots) {
			ops.push([TestDiffOpType.Remove, root]);
		}

		this.roots.clear();
		this.items.clear();

		return ops;
	}

	protected createItem(internal: InternalTestItem): IncrementalTestCollectionItem {
		return { ...internal, children: new Set() };
	}
}
