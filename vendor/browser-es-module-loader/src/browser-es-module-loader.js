import RegisterLoader from 'es-module-loader/core/register-loader.js';
import { InternalModuleNamespace as ModuleNamespace } from 'es-module-loader/core/loader-polyfill.js';

import { baseURI, global, isBrowser } from 'es-module-loader/core/common.js';
import { resolveIfNotPlain } from 'es-module-loader/core/resolve.js';

var loader;

// <script type="module"> support
var anonSources = {};
if (typeof document != 'undefined' && document.getElementsByTagName) {
  function ready() {
    document.removeEventListener('DOMContentLoaded', ready, false );

    var anonCnt = 0;

    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var script = scripts[i];
      if (script.type == 'module' && !script.loaded) {
        script.loaded = true;
        if (script.src) {
          loader.import(script.src).catch(function(err) {
              // dispatch an error event so that we can display in errors in browsers
              // that don't yet support unhandledrejection
              try {
                  var evt = new Event('error');
              } catch (_eventError) {
                  var evt = document.createEvent('Event');
                  evt.initEvent('error', true, true);
              }
              evt.message = err.message;
              evt.error = err;
              window.dispatchEvent(evt);

              // throw so it still shows up in the console
              throw err;
          });
        }
        // anonymous modules supported via a custom naming scheme and registry
        else {
          var uri = './<anon' + ++anonCnt + '>';
          if (script.id !== ""){
            uri = "./" + script.id;
          }

          var anonName = resolveIfNotPlain(uri, baseURI);
          anonSources[anonName] = script.innerHTML;
          loader.import(anonName).catch(function(err) {
              // dispatch an error event so that we can display in errors in browsers
              // that don't yet support unhandledrejection
              try {
                  var evt = new Event('error');
              } catch (_eventError) {
                  var evt = document.createEvent('Event');
                  evt.initEvent('error', true, true);
              }
              evt.message = err.message;
              evt.error = err;
              window.dispatchEvent(evt);

              // throw so it still shows up in the console
              throw err;
          });
        }
      }
    }
  }

  // simple DOM ready
  if (document.readyState === 'complete')
    setTimeout(ready);
  else
    document.addEventListener('DOMContentLoaded', ready, false);
}

function BrowserESModuleLoader(baseKey) {
  if (baseKey)
    this.baseKey = resolveIfNotPlain(baseKey, baseURI) || resolveIfNotPlain('./' + baseKey, baseURI);

  RegisterLoader.call(this);

  var loader = this;

  // ensure System.register is available
  global.System = global.System || {};
  if (typeof global.System.register == 'function')
    var prevRegister = global.System.register;
  global.System.register = function() {
    loader.register.apply(loader, arguments);
    if (prevRegister)
      prevRegister.apply(this, arguments);
  };
}
BrowserESModuleLoader.prototype = Object.create(RegisterLoader.prototype);

// normalize is never given a relative name like "./x", that part is already handled
BrowserESModuleLoader.prototype[RegisterLoader.resolve] = function(key, parent) {
  var resolved = RegisterLoader.prototype[RegisterLoader.resolve].call(this, key, parent || this.baseKey) || key;
  if (!resolved)
    throw new RangeError('ES module loader does not resolve plain module names, resolving "' + key + '" to ' + parent);

  return resolved;
};

function xhrFetch(url, resolve, reject) {
  var xhr = new XMLHttpRequest();
  function load(source) {
    resolve(xhr.responseText);
  }
  function error() {
    reject(new Error('XHR error' + (xhr.status ? ' (' + xhr.status + (xhr.statusText ? ' ' + xhr.statusText  : '') + ')' : '') + ' loading ' + url));
  }

  xhr.onreadystatechange = function () {
    if (xhr.readyState === 4) {
      // in Chrome on file:/// URLs, status is 0
      if (xhr.status == 0) {
        if (xhr.responseText) {
          load();
        }
        else {
          // when responseText is empty, wait for load or error event
          // to inform if it is a 404 or empty file
          xhr.addEventListener('error', error);
          xhr.addEventListener('load', load);
        }
      }
      else if (xhr.status === 200) {
        load();
      }
      else {
        error();
      }
    }
  };
  xhr.open("GET", url, true);
  xhr.send(null);
}

var WorkerPool = function (script, size) {
  this._workers = new Array(size);
  this._ind = 0;
  this._size = size;
  this._jobs = 0;
  this.onmessage = undefined;
  this._stopTimeout = undefined;
  for (let i = 0; i < size; i++) {
    let wrkr = new Worker(script);
    wrkr._count = 0;
    wrkr._ind = i;
    wrkr.onmessage = this._onmessage.bind(this, wrkr);
    this._workers[i] = wrkr;
  }

  this._checkJobs();
};
WorkerPool.prototype = {
  postMessage: function (msg) {
    if (this._stopTimeout !== undefined) {
      clearTimeout(this._stopTimeout);
      this._stopTimeout = undefined;
    }
    let wrkr = this._workers[this._ind % this._size];
    wrkr._count++;
    this._jobs++;
    wrkr.postMessage(msg);
    this._ind++;
  },

  _onmessage: function (wrkr, evt) {
    wrkr._count--;
    this._jobs--;
    this.onmessage(evt, wrkr);
    this._checkJobs();
  },

  _checkJobs: function () {
    if (this._jobs === 0 && this._stopTimeout === undefined) {
      // wait for 2s of inactivity before stopping (that should be enough for local loading)
      this._stopTimeout = setTimeout(this._stop.bind(this), 2000);
    }
  },

  _stop: function () {
    this._workers.forEach(function(wrkr) {
      wrkr.terminate();
    });
  }
};

var promiseMap = new Map();
var babelWorker = new WorkerPool('/vendor/browser-es-module-loader/dist/babel-worker.js', 3);
babelWorker.onmessage = function (evt) {
    var promFuncs = promiseMap.get(evt.data.key);
    promFuncs.resolve(evt.data);
    promiseMap.delete(evt.data.key);
};

// instantiate just needs to run System.register
// so we fetch the source, convert into the Babel System module format, then evaluate it
BrowserESModuleLoader.prototype[RegisterLoader.instantiate] = function(key, processAnonRegister) {
  var loader = this;

  // load as ES with Babel converting into System.register
  return new Promise(function(resolve, reject) {
    // anonymous module
    if (anonSources[key]) {
      resolve(anonSources[key])
      anonSources[key] = undefined;
    }
    // otherwise we fetch
    else {
      xhrFetch(key, resolve, reject);
    }
  })
  .then(function(source) {
    // check our cache first
    const cacheEntryTrans = localStorage.getItem(key+'!transpiled');
    if (cacheEntryTrans) {
      const cacheEntryRaw = localStorage.getItem(key+'!raw');
      // TODO: store a hash instead
      if (cacheEntryRaw === source) {
        return Promise.resolve({key: key, code: cacheEntryTrans, source: source});
      }
    }
    return new Promise(function (resolve, reject) {
      promiseMap.set(key, {resolve: resolve, reject: reject});
      babelWorker.postMessage({key: key, source: source});
    });
  }).then(function (data) {
    // evaluate without require, exports and module variables
    // we leave module in for now to allow module.require access
    if (data.key.slice(-8) !== '#nocache') {
        localStorage.setItem(key+'!raw', data.source);
        localStorage.setItem(data.key+'!transpiled', data.code);
    }
    (0, eval)(data.code + '\n//# sourceURL=' + data.key + '!transpiled');
    processAnonRegister();
  });
};

// create a default loader instance in the browser
if (isBrowser)
  loader = new BrowserESModuleLoader();

export default BrowserESModuleLoader;
