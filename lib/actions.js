const bus = require('./bus');
const {expect} = require('chai');
const AssertionError = require('assertion-error');
const options = require('./options');

const createMissingMethodOrPropertyProxy = require('./proxy-method-or-property-missing');
const getCheckedProperty = require('./get-checked-property');
const decorateExtend = require('./decorate-extend');

const {describeInstance} = require('./log-util');
const {describe_, before_, it_} = require('./log-util');
const logia = require('logia')("yemen/actions");
const {specLog} = require('./log-util');

class Action {
	constructor(parentAction, description, callback) {
		if(this.generateSpec === undefined) {
			throw new Error("Action is an abstract class and cannot be instantiated directly, please implement: generateSpec()");
		}

		this.parentAction = parentAction;
		this.description = description;
		this.callback = callback;
		this.childActions = [];
	}
	get ancestors() {
		const ancestors = [];

		let current = this;
		while(current) {
			ancestors.push(current);
			current = current.parentAction;
		}

		return ancestors;
	}
	do(resultOfPreviousAction) {
		bus.trigger('executingAction', this);
		return this.callback(resultOfPreviousAction);
		bus.trigger('actionExecuted', this);
	}
}
// Note: deliberate 'function'
Action.newInstance = function(...args) {
	return new this(...args);
};

class DescribeAction extends Action {
	generateSpec(getResultOfPreviousAction=() => {}) {
		describe_(`when doing ${this.description}`, () => {
			let resultOfCurrentAction
			before_(() => {
				resultOfCurrentAction = this.do(getResultOfPreviousAction());
			});

			this.childActions.forEach((childAction) => childAction.generateSpec(() => resultOfCurrentAction));
		});
	}
}

class RootAction extends DescribeAction {
	constructor(...args) {
		super(null, ...args)
	}
}

class ItAction extends Action {
	generateSpec(getResultOfPreviousAction=() => {}) {
		const descriptionChunks = [];
		let currentAction = this;
		while(currentAction) {
			descriptionChunks.push(currentAction.description);
			if(typeof currentAction === "function" && currentAction.getArgs()) {
				descriptionChunks.push(`${currentAction.getArgs().map((e) => JSON.stringify(e)).join(",")}`);
			}
			currentAction = currentAction.childActions[0];
		}

		it_(descriptionChunks.join(" "), () => {
			const resultOfCurrentAction = this.do(getResultOfPreviousAction());
			this.childActions.forEach((childAction) => childAction.generateSpec(() => resultOfCurrentAction));
		});
	}
}

class ChaiComponentAction extends Action {
	generateSpec(getResultOfPreviousAction=() => {}) {
		const resultOfCurrentAction = this.do(getResultOfPreviousAction());
		this.childActions.forEach((childAction) => childAction.generateSpec(() => resultOfCurrentAction));
	}
	do(resultOfPreviousAction) {
		let result;

		try {
			result = this.callback(resultOfPreviousAction);
		} catch(e) {
			let unhandledException;
			if(e instanceof AssertionError) {
				const isDescendantOfShouldEventually = this.ancestors.some((a) => a.description === "shouldEventually");
				if(isDescendantOfShouldEventually || options.shouldMeansShouldEventually) {
					const attemptCallback = () => {
							unhandledException = undefined;
							const ancestors = this.parentAction.ancestors;
							resultOfPreviousAction = ancestors
								.reverse()
								.reduce((resultOfPreviousAction, action) => action.do(resultOfPreviousAction), null)
							;
							result = this.callback(resultOfPreviousAction);
					};
					const MAX_RETRIES = 5;
					for(let retryAttempt = 0; retryAttempt < MAX_RETRIES; retryAttempt++) {
						try {
							logia.info(`Assertion failed; retrying... ${retryAttempt+1}/${MAX_RETRIES}`);
							options.delay(attemptCallback);
							break;
						} catch(e) {
							unhandledException = e;
						}
					}
				} else {
					unhandledException = e;
				}
			} else {
				unhandledException = e;
			}

			if(unhandledException) {
				throw unhandledException;
			}
		}

		return result;
	}
}
ChaiComponentAction.newInstance = function(...args) {
	const chaiComponentAction = new this(...args);

	let invocationArgs = null;
	const f = function(...args2) {
		invocationArgs = args2;
	};
	const invocableChaiComponentAction = decorateExtend(f, chaiComponentAction);
	invocableChaiComponentAction.getArgs = () => invocationArgs;

	return invocableChaiComponentAction;
};

// Creates a missing method proxy action.
const createMissingMethodProxyAction = (parentAction, methodName, ...args) => {
	if(typeof methodName !== "string" || methodName === 'should' || methodName === 'inspect') {
		return null;
	}
	specLog(`creating proxy method: ${methodName}`);

	const childAction = DescribeAction.create(parentAction, methodName + `(${JSON.stringify(args).slice(1,-1)})`, (context) => {
		logia.debug(`invoking ${describeInstance(context)}.${methodName}(${
			args
				.map((arg) => JSON.stringify(arg))
				.join(",")
		})`);

		return getCheckedProperty(context, methodName, 'function')(...args);
	});

	parentAction.childActions.push(childAction);

	return childAction;
};

// Creates a missing property proxy action (if possible).
// If creating such a property proxy action cannot be created, this function
// return undefined (allowing e.g. a method proxy action to be created).
const createMissingPropertyProxyAction = (parentAction, propertyName) => {
	let property; // must be undefined by default

	if(typeof propertyName === "string" && propertyName !== "inspect") {
		const isShouldActionDescription = (description) => description === "should" || description === "shouldEventually";
		const isDescendantOfShould = parentAction.ancestors.some((a) => isShouldActionDescription(a.description));

		if(isShouldActionDescription(propertyName)) {
			specLog(`creating proxy property: ${propertyName.toString()}`);
			const childAction = ItAction.create(parentAction, propertyName, (context) => expect(context).to);

			parentAction.childActions.push(childAction);
			property = childAction;
		} else if(isDescendantOfShould) {
			specLog(`creating proxy property: ${propertyName.toString()}`);

			const childAction = ChaiComponentAction.create(parentAction, propertyName, (context) => {
				let result;

				const args = childAction.getArgs();
				if(args) {
					result = getCheckedProperty(context, propertyName, 'function')(...args);
				} else {
					// This maps 'shouldEventually' to chai 'should':
					propertyName === "shouldEventually" ? should : propertyName;
					result = getCheckedProperty(context, propertyName, 'property');
				}

				return result;
			});

			parentAction.childActions.push(childAction);
			property = childAction;
		}
	}

	return property;
};

// Note: deliberate 'function'
Action.create = function(...args) {
	const action = this.newInstance(...args);

	const proxiedAction = createMissingMethodOrPropertyProxy(
		action,
		(...args2) => createMissingMethodProxyAction(action, ...args2),
		(...args2) => createMissingPropertyProxyAction(action, ...args2)
	);

	return proxiedAction;
};

module.exports = {
	RootAction,
	ItAction,
};
