'use strict';

const TITLE_DL_VIEW = 'HG ++';
const TITLE_OPTIONS_VIEW = 'Options - HG ++';


/* Fields */

// Initialize the queue.
var queue = newQueue(handleProcessorFn);

// Initialize the dictionary
var dictionaryWrapper = null;

// Initialize the download manager
var dlManager = newDlManager(queue);

// Already visited URLs
var alreadyVisitedUrls = newAlreadyVisitedUrls();


/* Default actions */

// Create the menus
browser.contextMenus.create({
  id: 'hg-menu',
  title: 'Host Grabber',
  contexts: ['all']
});

browser.contextMenus.create({
  id: 'hg-menu-download',
  parentId: 'hg-menu',
  title: browser.i18n.getMessage('menu_extractAndDownload'),
  contexts: ['all'],
  // Important: do not remove the 'function() {' part.
  // downloadContentFromCurrentTab takes arguments
  // and writing it directly results in errors
  // (an argument is set automatically while none should be set).
  onclick: function() { downloadContentFromCurrentTab(); }
});

browser.contextMenus.create({
  id: 'hg-menu-donwload-direct-images',
  parentId: 'hg-menu',
  title: browser.i18n.getMessage('menu_downloadDirectImages'),
  contexts: ['all'],
  onclick: downloadDirectImages
});

browser.contextMenus.create({
  id: 'separator-1',
  parentId: 'hg-menu',
  type: 'separator',
  contexts: ['all']
});


browser.contextMenus.create({
  id: 'hg-menu-show-dl-list',
  parentId: 'hg-menu',
  title: browser.i18n.getMessage('menu_showDownloadList'),
  contexts: ['all'],
  onclick: showDownloadsList
});

browser.contextMenus.create({
  id: 'hg-menu-options',
  parentId: 'hg-menu',
  title: browser.i18n.getMessage('menu_showOptions'),
  contexts: ['all'],
  onclick: showOptionsPage
});


// Commands
browser.commands.onCommand.addListener((command) => {
  if (command === 'dl') {
    downloadContentFromCurrentTab();
  }
});


// Messages
browser.runtime.onMessage.addListener(request => {
  if (request.req === 'dictionary-update') {
    downloadDictionary();

  } else if (request.req === 'get-processors') {
    var history = Array.from(queue.processingHistory.values());
    sendProcessorsToDownloadView(history);

  } else if (request.req === 'remove-processor') {
    queue.remove(request.obj);

  } else if (request.req === 'restart-download') {
    request.obj.downloadLinks.forEach( function(dlLink) {
      removeFromArray(alreadyVisitedUrls, dlLink);
    });

    queue.reschedule(request.obj);

  } else if (request.req === 'clear-already-visited-urls') {
    alreadyVisitedUrls.list.length = 0;
    notifyOptionsPage({req: 'clear-already-visited-urls-cb'});
  }
});

browser.runtime.onMessageExternal.addListener(request => {
  if (request.req === 'explore-page' && typeof request.page === 'string') {
    downloadContentFromURL(request.page);
  }
});

// Restore the dictionary when the browser starts...
// ... or when the extension is installed or updated.
browser.runtime.onStartup.addListener(restoreDictionary);
browser.runtime.onInstalled.addListener(restoreDictionary);

// Deal with the cache for download links
browser.storage.local.get('dlCacheDownloadLinks').then((res) => {
  alreadyVisitedUrls.enabled = res.dlCacheDownloadLinks || defaultDlCacheDownloadLinks;
});

// Listen to changes for this preference
browser.storage.onChanged.addListener(function(changes, area) {
  if (area === 'local' && changes.hasOwnProperty( 'dlCacheDownloadLinks' )) {
    alreadyVisitedUrls.enabled = changes.dlCacheDownloadLinks.newValue;
  }
});



/* Functions */

/**
 * Restores the dictionary.
 * <p>
 * If it is not saved locally, download it.
 * </p>
 *
 * @returns {undefined}
 */
function restoreDictionary() {

  browser.storage.local.get('mainDictionary').then((res) => {
    console.log('Restoring local dictionary...');
    var dictionary = new DOMParser().parseFromString(res.mainDictionary,'text/xml')
    dictionaryWrapper = parseAndVerifyDictionary(dictionary);

  }).finally( function() {
    browser.storage.local.get('automaticallyUpdateDictionary').then((res) => {
      if (!! res.automaticallyUpdateDictionary || defaultAutomaticallyUpdateDictionary) {
        downloadDictionary();
      } else {
        sendDictionaryToSidebar();
      }
    });
  });
}


/**
 * Saves the dictionary locally.
 * @param {object} dictionary The dictionary, as a DOM document.
 * @returns {undefined}
 */
function saveDictionary(dictionary) {

  if (!! dictionary) {
    var newXmlStr = new XMLSerializer().serializeToString(dictionary);
    browser.storage.local.set({
      mainDictionary: newXmlStr
    });
  }
}


/**
 * Downloads the dictionary.
 * @returns {undefined}
 */
function downloadDictionary() {

  browser.storage.local.get('dictionaryUrl').then((res) => {
    var url = res.dictionaryUrl || defaultDictionaryUrl;

    // By-pass the browser cache...
    url += ((/\?/).test(url) ? '&' : '?') + (new Date()).getTime();

    console.log('Loading dictionary from ' + url + '...');
    loadRemoteDocument(url, true, 'application/xml').then( function(downloadedDictionary) {
      updateDictionary(downloadedDictionary);

    }, function(details) {
      notifyDictionaryReload('ko');
      console.log('Dictionary could not be loaded from ' + url + '.');
      console.log(details);
    });
  });
}


/**
 * Updates the dictionary, when possible.
 * <p>
 * The new dictionary must have a more recent version and be compliant
 * with the specs this extension supports.
 * </p>
 *
 * @param {object} newDictionary The new dictionary.
 * @returns {undefined}
 */
function updateDictionary(newDictionary) {
  var dictionarySpec = newDictionary.documentElement.getAttribute('spec');

  // Is the remote dictionary supported by this version of HG?
  if (supportedDictionarySpecs.indexOf(dictionarySpec) !== -1) {
    console.log('Upgrading the local dictionary to a new version...');
    saveDictionary(newDictionary);
    dictionaryWrapper = parseAndVerifyDictionary(newDictionary);
    sendDictionaryToSidebar();
    notifyDictionaryReload('ok');

  } else {
    notifyDictionaryReload('us');
  }
}


/**
 * Notifies a dictionary reload to the options page (provided it is open).
 * @param {string} status The status ('ok' or 'ko').
 * @returns {undefined}
 */
function notifyDictionaryReload(status) {
  notifyOptionsPage({req: 'dictionary-reload-cb', status: status});
}


/**
 * Notifies the options page (provided it is open).
 * @param {object} message A message object.
 * @returns {undefined}
 */
function notifyOptionsPage(message) {

  browser.tabs.query({ title: TITLE_OPTIONS_VIEW }).then( function(tabs) {
    tabs.forEach(function(tab) {
      browser.tabs.sendMessage(tab.id, message);
    });
  });
}


/**
 * Shows the download list.
 * @param {boolean} checkPreferences True to check preferences before showing the list, false to directly show the list.
 * @returns {undefined}
 */
function showDownloadsList() {
  showTab(TITLE_DL_VIEW, '/src/html/download-list.html');
}


/**
 * Downloads the content by analyzing the source code of the current tab.
 * @param {object} dictionaryWrapperToUse A dictionary wrapper (optional).
 * @returns {undefined}
 */
function downloadContentFromCurrentTab(dictionaryWrapperToUse) {

  // Get the page's source code.
  // Background scripts cannot directly get it, so we ask it to our content
  // script (in the currently active tab). So we have to go through the tab API.
  browser.tabs.query({active: true, currentWindow: true}).then( tabs => {
    browser.tabs.sendMessage( tabs[0].id, {req: 'source-code'}).then( sourceAsText => {
      console.log(dictionaryWrapperToUse)
      downloadContentFromText(sourceAsText, tabs[0].url, dictionaryWrapperToUse);
    });
  });
}


/**
 * Downloads direct images in the current tab.
 * @returns {undefined}
 */
function downloadDirectImages() {
  downloadContentFromCurrentTab( buildDictionaryWrapperForDirectImages());
}


/**
 * Downloads the content by analyzing a given URL.
 * @param {string} url An URL to explore.
 * @returns {undefined}
 */
function downloadContentFromURL(url) {

  // Get the page's source code.
  loadRemoteDocument(url, false).then( sourceAsText => {
    downloadContentFromText(sourceAsText, url);
  }, error => {
    console.log('Failed to get the source code from: ' + url);
  });
}


/**
 * Downloads the content by analyzing a given source code.
 * @param {string} sourceAsText The source code to analyze.
 * @param {string} url The URL of the page.
 * @param {object} dictionaryWrapperToUse A dictionary wrapper (optional).
 * @returns {undefined}
 */
function downloadContentFromText(sourceAsText, url, dictionaryWrapperToUse) {

  // Open the download tab
  showDownloadsList();

  // Parse the source code and find the links
  var dw = dictionaryWrapperToUse || dictionaryWrapper;
  var sourceDocument = new DOMParser().parseFromString(sourceAsText,'text/html');
  var processors = findWhatToProcess(sourceDocument, url, dw);

  // We get link candidates to process and/or explore
  processors.forEach(function(processor) {
    queue.append(processor);
  });

  // Send a notification to the downloads view
  sendProcessorsToDownloadView(processors);

  // Start downloading
  queue.processNextItem();
}


/**
 * Sends processors to the download view.
 * @param {array} processors An array of processors.
 * @returns {undefined}
 */
function sendProcessorsToDownloadView(processors) {
  sendProcessorsToTab(processors, TITLE_DL_VIEW);
}


/**
 * Sends processors to the download view.
 * @param {array} processors An array of processors.
 * @param {string} tabTitle The tab's title.
 * @param {object} options Various options.
 * @returns {undefined}
 */
function sendProcessorsToTab(processors, tabTitle, options) {

  var clones = prepareProcessorsForMessaging(processors);
  browser.tabs.query({ title: tabTitle }).then( function(tabs) {
    if (tabs.length > 0) {
      browser.tabs.sendMessage(tabs[0].id, {req: 'new-processors', obj: clones, options: options});
    }
  });
}


/**
 * Updates a processor in the download view.
 * @param {object} processor A processor.
 * @returns {undefined}
 */
function updateProcessorInDownloadView(processor) {
  updateProcessorInTab(processor, TITLE_DL_VIEW);
}


/**
 * Updates a processor in the download view.
 * @param {object} processor A processor.
 * @param {string} tabTitle The tab's title.
 * @returns {undefined}
 */
function updateProcessorInTab(processor, tabTitle) {

  var clone = prepareProcessorForMessaging(processor);
  browser.tabs.query({ title: tabTitle }).then( function(tabs) {
    if (tabs.length > 0) {
      browser.tabs.sendMessage(tabs[0].id, {req: 'update-processor', obj: clone});
    }
  });
}


/**
 * Handles the execution of a processor.
 * @param {object} processor A processor.
 * @returns {undefined}
 */
function handleProcessorFn(processor) {
  // We use this function as a proxy so that we can...
  // - Get download links.
  // - Update the view.
  handleProcessor(processor, extractor(), queue, dlManager.startDownload, updateProcessorInDownloadView, alreadyVisitedUrls);
}
