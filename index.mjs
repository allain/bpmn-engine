import BpmnModdle from 'bpmn-moddle';
import DebugLogger from './lib/Logger.mjs';
import Elements from 'bpmn-elements';
import getOptionsAndCallback from './lib/getOptionsAndCallback.mjs';
import JavaScripts from './lib/JavaScripts.mjs';
import ProcessOutputDataObject from './lib/extensions/ProcessOutputDataObject.mjs';
import { Broker } from 'smqp';
import ModdleSerializer from 'moddle-context-serializer';
import { EventEmitter } from 'events';

const { default: serializer, deserialize, TypeResolver } = ModdleSerializer;
const kEngine = Symbol.for('engine');
const kEnvironment = Symbol.for('environment');
const kExecuting = Symbol.for('executing');
const kExecution = Symbol.for('execution');
const kLoadedDefinitions = Symbol.for('loaded definitions');
const kOnBrokerReturn = Symbol.for('onBrokerReturn');
const kPendingSources = Symbol.for('pending sources');
const kSources = Symbol.for('sources');
const kState = Symbol.for('state');
const kStopped = Symbol.for('stopped');
const kTypeResolver = Symbol.for('type resolver');

import fs from 'fs';

const { version: engineVersion } = JSON.parse(
  fs.readFileSync('./package.json', 'utf-8')
);

export class Engine extends EventEmitter {
  constructor(options = {}) {
    super();

    const opts = (this.options = {
      Logger: DebugLogger,
      scripts: new JavaScripts(options.disableDummyScript),
      ...options
    });

    this.logger = opts.Logger('engine');

    this[kTypeResolver] = TypeResolver(
      {
        ...Elements,
        ...(opts.elements || {})
      },
      opts.typeResolver || defaultTypeResolver
    );

    this[kEnvironment] = new Elements.Environment(opts);

    const broker = (this.broker = new Broker(this));
    broker.assertExchange('event', 'topic', { autoDelete: false });

    this[kExecution] = null;
    this[kLoadedDefinitions] = null;
    this[kSources] = [];

    const pendingSources = (this[kPendingSources] = []);
    if (opts.source) pendingSources.push(this._serializeSource(opts.source));
    if (opts.moddleContext) {
      pendingSources.push(this._serializeModdleContext(opts.moddleContext));
    }
    if (opts.sourceContext) pendingSources.push(opts.sourceContext);
  }

  get name() {
    return this.options.name;
  }
  set name(newName) {
    this.options.name = newName;
  }

  get environment() {
    return this[kEnvironment];
  }

  get state() {
    const execution = this.execution;
    if (execution) return execution.state;
    return 'idle';
  }

  get stopped() {
    const execution = this.execution;
    if (execution) return execution.stopped;
    return false;
  }
  get execution() {
    return this[kExecution];
  }

  async execute(...args) {
    const [executeOptions, callback] = getOptionsAndCallback(...args);
    try {
      var definitions = await this._loadDefinitions(executeOptions); // eslint-disable-line no-var
    } catch (err) {
      if (callback) return callback(err);
      throw err;
    }

    const execution = (this[kExecution] = new Execution(
      this,
      definitions,
      this.options
    ));
    return execution._execute(executeOptions, callback);
  }

  stop() {
    const execution = this.execution;
    if (!execution) return;
    return execution.stop();
  }

  recover(savedState, recoverOptions) {
    if (!savedState) return this;

    let name = this.name;
    if (!name) name = this.name = savedState.name;

    this.logger.debug(`<${name}> recover`);

    if (recoverOptions) {
      this[kEnvironment] = new Elements.Environment(recoverOptions);
    }
    if (savedState.environment) {
      this[kEnvironment] = this[kEnvironment].recover(savedState.environment);
    }

    if (!savedState.definitions) return this;

    const pendingSources = this[kPendingSources];
    const preSources = pendingSources.splice(0);

    const typeResolver = this[kTypeResolver];
    const loadedDefinitions = (this[kLoadedDefinitions] =
      savedState.definitions.map((dState) => {
        let source;
        if (dState.source) {
          source = deserialize(JSON.parse(dState.source), typeResolver);
        } else source = preSources.find((s) => s.id === dState.id);

        pendingSources.push(source);

        this.logger.debug(`<${name}> recover ${dState.type} <${dState.id}>`);

        const definition = this._loadDefinition(source);
        definition.recover(dState);

        return definition;
      }));

    this[kExecution] = new Execution(this, loadedDefinitions, {}, true);

    return this;
  }

  async resume(...args) {
    const [resumeOptions, callback] = getOptionsAndCallback(...args);

    let execution = this.execution;
    if (!execution) {
      const definitions = await this.getDefinitions();
      if (!definitions.length) {
        const err = new Error('nothing to resume');
        if (callback) return callback(err);
        throw err;
      }
      execution = this[kExecution] = new Execution(
        this,
        definitions,
        this.options
      );
    }

    return execution._resume(resumeOptions, callback);
  }

  addSource({ sourceContext: addContext } = {}) {
    if (!addContext) return;
    const loadedDefinitions = this[kLoadedDefinitions];
    if (loadedDefinitions) loadedDefinitions.splice(0);
    this[kPendingSources].push(addContext);
  }

  async getDefinitions(executeOptions) {
    const loadedDefinitions = this[kLoadedDefinitions];
    if (loadedDefinitions && loadedDefinitions.length) return loadedDefinitions;
    return this._loadDefinitions(executeOptions);
  }

  async getDefinitionById(id) {
    return (await this.getDefinitions()).find((d) => d.id === id);
  }

  async getState() {
    const execution = this.execution;
    if (execution) return execution.getState();

    const definitions = await this.getDefinitions();
    return new Execution(this, definitions, this.options).getState();
  }

  waitFor(eventName) {
    const self = this;
    return new Promise((resolve, reject) => {
      self.once(eventName, onEvent);
      self.once('error', onError);

      function onEvent(api) {
        self.removeListener('error', onError);
        resolve(api);
      }
      function onError(err) {
        self.removeListener(eventName, onEvent);
        reject(err);
      }
    });
  }

  async _loadDefinitions(executeOptions) {
    const runSources = await Promise.all(this[kPendingSources]);
    const loadedDefinitions = (this[kLoadedDefinitions] = runSources.map(
      (source) => this._loadDefinition(source, executeOptions)
    ));
    return loadedDefinitions;
  }

  _loadDefinition(serializedContext, executeOptions = {}) {
    const { settings, variables } = executeOptions;

    const environment = this.environment;
    const context = new Elements.Context(
      serializedContext,
      environment.clone({
        listener: environment.options.listener,
        ...executeOptions,
        settings: {
          ...environment.settings,
          ...settings
        },
        variables: {
          ...environment.variables,
          ...variables
        },
        source: serializedContext
      })
    );

    return new Elements.Definition(context);
  }

  async _serializeSource(source) {
    const moddleContext = await this._getModdleContext(source);
    return this._serializeModdleContext(moddleContext);
  }

  _serializeModdleContext(moddleContext) {
    const serialized = serializer(moddleContext, this[kTypeResolver]);
    this[kSources].push(serialized);
    return serialized;
  }

  _getModdleContext(source) {
    const bpmnModdle = new BpmnModdle(this.options.moddleOptions);
    return bpmnModdle.fromXML(
      Buffer.isBuffer(source) ? source.toString() : source.trim()
    );
  }
}

function defaultTypeResolver(elementTypes) {
  elementTypes['bpmn:DataObject'] = ProcessOutputDataObject;
  elementTypes['bpmn:DataStoreReference'] = ProcessOutputDataObject;
}

export class Execution {
  constructor(engine, definitions, options, isRecovered = false) {
    this.name = engine.name;
    this.options = options;
    this.definitions = definitions;
    this[kState] = 'idle';
    this[kStopped] = isRecovered;
    this[kEnvironment] = engine.environment;
    this[kEngine] = engine;
    this[kExecuting] = [];
    const onBrokerReturn = (this[kOnBrokerReturn] =
      this._onBrokerReturn.bind(this));
    engine.broker.on('return', onBrokerReturn);
  }

  get state() {
    return this[kState];
  }

  get stopped() {
    return this[kStopped];
  }

  get broker() {
    return this[kEngine].broker;
  }

  get environment() {
    return this[kEnvironment];
  }

  _execute(executeOptions, callback) {
    this._setup(executeOptions);
    this[kStopped] = false;
    this._debug('execute');

    this._addConsumerCallbacks(callback);
    const definitionExecutions = this.definitions.reduce(
      (result, definition) => {
        if (!definition.getExecutableProcesses().length) return result;
        result.push(definition.run());
        return result;
      },
      []
    );

    if (!definitionExecutions.length) {
      const error = new Error('No executable processes');
      if (!callback) return this[kEngine].emit('error', error);
      return callback(error);
    }

    return this;
  }

  _resume(resumeOptions, callback) {
    this._setup(resumeOptions);

    this[kStopped] = false;
    this._debug('resume');
    this._addConsumerCallbacks(callback);

    this[kExecuting].splice(0);
    this.definitions.forEach((definition) => definition.resume());

    return this;
  }

  _addConsumerCallbacks(callback) {
    if (!callback) return;

    const broker = this.broker;
    const onBrokerReturn = this[kOnBrokerReturn];

    broker.off('return', onBrokerReturn);

    clearConsumers();

    broker.subscribeOnce(
      'event',
      'engine.stop',
      () => {
        clearConsumers();
        return callback(null, this);
      },
      { consumerTag: 'ctag-cb-stop' }
    );

    broker.subscribeOnce(
      'event',
      'engine.end',
      () => {
        clearConsumers();
        return callback(null, this);
      },
      { consumerTag: 'ctag-cb-end' }
    );

    broker.subscribeOnce(
      'event',
      'engine.error',
      (_, message) => {
        clearConsumers();
        return callback(message.content);
      },
      { consumerTag: 'ctag-cb-error' }
    );

    return callback;

    function clearConsumers() {
      broker.cancel('ctag-cb-stop');
      broker.cancel('ctag-cb-end');
      broker.cancel('ctag-cb-error');
      broker.on('return', onBrokerReturn);
    }
  }

  async stop() {
    const engine = this[kEngine];
    const prom = engine.waitFor('stop');
    this[kStopped] = true;
    const timers = engine.environment.timers;

    timers.executing.slice().forEach((ref) => timers.clearTimeout(ref));

    this[kExecuting].splice(0).forEach((d) => d.stop());

    const result = await prom;
    this[kState] = 'stopped';
    return result;
  }

  _setup(setupOptions = {}) {
    const listener = setupOptions.listener || this.options.listener;
    if (listener && typeof listener.emit !== 'function') {
      throw new Error('listener.emit is not a function');
    }

    const onChildMessage = this._onChildMessage.bind(this);

    for (const definition of this.definitions) {
      if (listener) definition.environment.options.listener = listener;

      definition.broker.subscribeTmp('event', 'definition.#', onChildMessage, {
        noAck: true,
        consumerTag: '_engine_definition'
      });
      definition.broker.subscribeTmp('event', 'process.#', onChildMessage, {
        noAck: true,
        consumerTag: '_engine_process'
      });
      definition.broker.subscribeTmp('event', 'activity.#', onChildMessage, {
        noAck: true,
        consumerTag: '_engine_activity'
      });
      definition.broker.subscribeTmp('event', 'flow.#', onChildMessage, {
        noAck: true,
        consumerTag: '_engine_flow'
      });
    }
  }

  _onChildMessage(routingKey, message, owner) {
    const { environment: ownerEnvironment } = owner;
    const listener =
      ownerEnvironment.options && ownerEnvironment.options.listener;
    this[kState] = 'running';

    let newState;
    const elementApi = owner.getApi && owner.getApi(message);

    switch (routingKey) {
      case 'definition.resume':
      case 'definition.enter': {
        const executing = this[kExecuting];
        const idx = executing.indexOf(owner);
        if (idx > -1) break;
        executing.push(owner);
        break;
      }
      case 'definition.stop': {
        this._teardownDefinition(owner);

        const executing = this[kExecuting];
        if (executing.some((d) => d.isRunning)) break;

        newState = 'stopped';
        this[kStopped] = true;
        break;
      }
      case 'definition.leave':
        this._teardownDefinition(owner);

        if (this[kExecuting].some((d) => d.isRunning)) break;

        newState = 'idle';
        break;
      case 'definition.error':
        this._teardownDefinition(owner);
        newState = 'error';
        break;
      case 'activity.wait': {
        if (listener) listener.emit('wait', owner.getApi(message), this);
        break;
      }
      case 'process.end': {
        if (!message.content.output) break;
        const environment = this.environment;

        for (const key in message.content.output) {
          switch (key) {
            case 'data': {
              environment.output.data = environment.output.data || {};
              environment.output.data = {
                ...environment.output.data,
                ...message.content.output.data
              };
              break;
            }
            default: {
              environment.output[key] = message.content.output[key];
            }
          }
        }
        break;
      }
    }

    if (listener) listener.emit(routingKey, elementApi, this);

    const broker = this.broker;
    broker.publish(
      'event',
      routingKey,
      { ...message.content },
      { ...message.properties, mandatory: false }
    );

    if (!newState) return;

    this[kState] = newState;

    switch (newState) {
      case 'stopped':
        this._debug('stopped');
        broker.publish('event', 'engine.stop', {}, { type: 'stop' });
        return this[kEngine].emit('stop', this);
      case 'idle':
        this._debug('completed');
        broker.publish('event', 'engine.end', {}, { type: 'end' });
        return this[kEngine].emit('end', this);
      case 'error':
        this._debug('error');
        return broker.publish('event', 'engine.error', message.content.error, {
          type: 'error',
          mandatory: true
        });
    }
  }

  _teardownDefinition(definition) {
    const executing = this[kExecuting];
    const idx = executing.indexOf(definition);
    if (idx > -1) executing.splice(idx, 1);

    definition.broker.cancel('_engine_definition');
    definition.broker.cancel('_engine_process');
    definition.broker.cancel('_engine_activity');
    definition.broker.cancel('_engine_flow');
  }

  getState() {
    const definitions = [];
    for (const definition of this.definitions) {
      definitions.push({
        ...definition.getState(),
        source: definition.environment.options.source.serialize()
      });
    }

    return {
      name: this[kEngine].name,
      state: this.state,
      stopped: this.stopped,
      engineVersion,
      environment: this.environment.getState(),
      definitions
    };
  }

  getActivityById(activityId) {
    for (const definition of this.definitions) {
      const activity = definition.getActivityById(activityId);
      if (activity) return activity;
    }
  }

  getPostponed() {
    const defs = this.stopped ? this.definitions : this[kExecuting];
    return defs.reduce((result, definition) => {
      result = result.concat(definition.getPostponed());
      return result;
    }, []);
  }

  signal(payload, { ignoreSameDefinition } = {}) {
    for (const definition of this[kExecuting]) {
      if (
        ignoreSameDefinition &&
        payload &&
        payload.parent &&
        payload.parent.id === definition.id
      ) {
        continue;
      }
      definition.signal(payload);
    }
  }

  cancelActivity(payload) {
    for (const definition of this[kExecuting]) {
      definition.cancelActivity(payload);
    }
  }

  waitFor(...args) {
    return this[kEngine].waitFor(...args);
  }

  _onBrokerReturn(message) {
    if (message.properties.type === 'error') {
      this[kEngine].emit('error', message.content);
    }
  }

  _debug(msg) {
    this[kEngine].logger.debug(`<${this.name}> ${msg}`);
  }
}
