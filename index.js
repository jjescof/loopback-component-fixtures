'use strict'

const fs = require('fs')
const path = require('path')
const appRoot = require('app-root-path').path
const async = require('async')
const merge = require('merge')
const DebugGenerator = require('debug')
const debug = DebugGenerator('loopback:component:fixtures:')
const debugSetup = DebugGenerator('loopback:component:fixtures:setup:verbose:')
const debugTeardown = DebugGenerator('loopback:component:fixtures:teardown:verbose:')

let models
let fixtureNames
let fixturePath
let cachedFixtures
let config

const defaults = {
  loadFixturesOnStartup: false,
  errorOnSetupFailure: false,
  environments: 'test',
  fixturesPath: '/server/test-fixtures/'
}

const createFixtureList = () => {
  const fixtureFolderContents = fs.readdirSync(fixturePath)
  return fixtureFolderContents.filter(fileName => fileName.match(/\.json$/))
    .map(fileName => fileName.replace('.json', ''))
}

const addToCache = (fixtureName) => {
  const fixtureData = require(fixturePath + fixtureName)
  cachedFixtures[fixtureName] = fixtureData
}

const loadFixture = (fixtureName, done) => {
  debugSetup('Loading fixture', fixtureName)

  /* istanbul ignore else */
  if (!cachedFixtures[fixtureName]) {
    debugSetup('Fixture not cached, loading from disk')
    addToCache(fixtureName)
  }

  debugSetup('Loading fixtures for', fixtureName)
  models[fixtureName].create(cachedFixtures[fixtureName], (err) => {
    if (err) {
      debugSetup('Error when attempting to add fixtures for', fixtureName)
      debugSetup(err)
    }

    done(err)
  })
}

const loadFixtures = (fixtures, cb) => {
  /* istanbul ignore else */
  if (!cachedFixtures) {
    debugSetup('No cached fixtures loading fixture files from', fixturePath)
    cachedFixtures = {}
    fixtureNames = createFixtureList()
  }

  if (!cb) {
    cb = fixtures
    async.each(fixtureNames, loadFixture, cb)
  } else {
    async.each(fixtures, loadFixture, cb)
  }
}

const init = (app, options) => {
  models = app.models
  config = merge(defaults, options)
  fixturePath = path.join(appRoot, config.fixturesPath)

  debug('Initializing component with options', config)

  const environment = app.settings && app.settings.env
    ? app.settings.env : process.env.NODE_ENV

  const match = Array.isArray(config.environments)
    ? config.environments.indexOf(environment) !== -1
    : environment === config.environments

  if (!match) {
    debug('Skipping fixtures because environment', environment, 'is not in options.environments')
    return
  }

  if (config.loadFixturesOnStartup) {
    loadFixtures((err) => {
      if (err) debug('Error when loading fixtures on startup:', err)
      if (err && config.errorOnSetupFailure) {
        throw new Error('Failed to load fixtures on startup:', err)
      }
    })
  }
}

const setupInterface = (app) => {
  const Fixtures = app.registry.createModel({name: 'Fixtures', base: 'Model'})

  app.model(Fixtures, {
    dataSource: false,
    base: 'Model'
  })

  Fixtures.setupFixtures = app.setupFixtures = (select, cb) => {
    if (typeof select === 'function') cb = select
    debug('Loading fixtures')
    const setupCallback = (errors) => {
      if (errors) debug('Fixtures failed to load:', errors)
      if (errors && config.errorOnSetupFailure) return cb(errors)

      cb(null, 'setup complete')
    }
    if (typeof select !== 'string') {
      debugSetup('Loading all fixtures in folder')
      loadFixtures(setupCallback)
    } else {
      /* istanbul ignore else */
      if (!Array.isArray(select)) select = select.split(',')
      debugSetup('Loading following fixtures: ', select)
      loadFixtures(select, setupCallback)
    }
  }

  Fixtures.teardownFixtures = app.teardownFixtures = (select, cb) => {
    if (typeof select === 'function') cb = select
    let fixturesToTeardown
    if (typeof select !== 'string') {
      fixturesToTeardown = fixtureNames
    } else {
      /* istanbul ignore else */
      if (!Array.isArray(select)) select = select.split(',')
      fixturesToTeardown = select
    }
    debugTeardown('Tearing down fixtures for', Object.keys(app.datasources))
    const dataSourceNames = Object.keys(app.datasources)
    const migrateDataSource = (dataSourceName, done) => {
      debugTeardown('Tearing down fixtures for', dataSourceName)
      const dataSource = app.datasources[dataSourceName]

      if (Array.isArray(fixtureNames)) {
        // build modelNames and modelNamesLower as a bit of hack to ensure we
        // migrate the correct model name. its not possible to figure out
        // which is the correct (lower or upper case) and automigrate doesn't
        // do anything if the case is incorrect.
        const modelNamesLower = fixturesToTeardown.map(modelName => modelName.toLowerCase())
        const modelNamesBothCases = fixturesToTeardown.concat(modelNamesLower)
        const remigrateModel = (model, done) => {
          debugTeardown('Dropping model', model, 'from', dataSourceName)
          dataSource.automigrate(model, (err) => {
            if (err) {
              debugTeardown('Error when attempting to automigrate', model)
              debugTeardown(err)
            } else {
              debugTeardown('Successfully migrated', model)
            }
            done(err)
          })
        }

        async.each(modelNamesBothCases, remigrateModel, done)
      } else {
        debugTeardown('Dropping all models for', dataSourceName)
        dataSource.automigrate(() => {
          debugTeardown('Returning fixture teardown success (ignoring success/fail messages)')
          done()
        })
      }
    }

    debug('Tearing down data sources:', dataSourceNames)
    async.each(dataSourceNames, migrateDataSource, (errors) => {
      if (errors) {
        debug('Failed to tear down fixtures:', errors)
        debug('Note that errors here does not necessarily mean the teardown')
        debug('itself failed you should look at your database to ensure that')
        debug('your collections/tables are now empty.')
      }
      debug('Returning fixture teardown success message')
      cb(null, 'teardown complete')
    })
  }

  Fixtures.remoteMethod('setupFixtures', {
    description: 'Setup fixtures',
    accepts: {arg: 'select', type: 'string', http: { source: 'query' }},
    returns: {arg: 'fixtures', type: 'string'},
    http: {path: '/setup', verb: 'get'}
  })

  Fixtures.remoteMethod('teardownFixtures', {
    description: 'Teardown fixtures',
    accepts: {arg: 'select', type: 'string', http: { source: 'query' }},
    returns: {arg: 'fixtures', type: 'string'},
    http: {path: '/teardown', verb: 'get'}
  })
}

module.exports = (app, options) => {
  init(app, options)
  setupInterface(app)
}
