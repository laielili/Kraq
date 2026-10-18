/* 线性图标（Lucide 风格内联 SVG，禁用 emoji 当功能图标） */
(function () {
  var P = {
    'book-open-text': [
      'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z',
      'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
      'M6 8h3', 'M6 12h3', 'M15 8h3', 'M15 12h3'
    ],
    book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
    archive: ['M2 4h20v5H2z', 'M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9', 'M10 13h4'],
    workflow: ['M3 3h8v8H3z', 'M13 13h8v8h-8z', 'M7 11v3a2 2 0 0 0 2 2h4'],
    settings2: ['M20 7h-9', 'M14 17H5', 'circle:17:17:3', 'circle:7:7:3'],
    'chevron-down': ['m6 9 6 6 6-6'],
    'chevron-right': ['m9 18 6-6-6-6'],
    'panel-right': ['M3 3h18v18H3z', 'M15 3v18'],
    'file-text': ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
    trash: ['M3 6h18', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', 'M10 11v6', 'M14 11v6', 'M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2'],
    'folder-open': ['M2 6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z'],
    link: ['M10 13a5 5 0 0 0 7.5.5l2.5-2.5a5 5 0 0 0-7-7L12 5.5', 'M14 11a5 5 0 0 0-7.5-.5L4 13a5 5 0 0 0 7 7l2.5-2.5'],
    'arrow-down-to-line': ['M12 17V3', 'm6 11 6 6 6-6', 'M5 21h14'],
    loader: ['M21 12a9 9 0 1 1-6.2-8.6'],
    brain: ['M12 5a3 3 0 0 0-6 0 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0z', 'M12 5a3 3 0 0 1 6 0 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 0z', 'M12 5v14'],
    'check-circle': ['M21.8 10A10 10 0 1 1 10 2.2', 'm9 12 2 2 4-4'],
    'alert-triangle': ['m10.3 3.9-8.4 14.6A2 2 0 0 0 3.7 21h16.6a2 2 0 0 0 1.7-2.5L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
    target: ['circle:12:12:10', 'circle:12:12:6', 'circle:12:12:2'],
    search: ['circle:11:11:8', 'm21 21-4.3-4.3'],
    'list-ordered': ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 5h1.5V9', 'M3 13h2l-2 3h2', 'M4 17v3'],
    'message-square': ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
    'shield-check': ['M20 13c0 5-3.5 7.5-7.7 10a.7.7 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.5 0C16.5 3.8 19 5 21 5a1 1 0 0 1 1 1z', 'm9 12 2 2 4-4'],
    send: ['m22 2-7 20-4-9-9-4z', 'M22 2 11 13'],
    square: ['M5 5h14v14H5z'],
    x: ['M18 6 6 18', 'M6 6l12 12'],
    plus: ['M12 5v14', 'M5 12h14'],
    pencil: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
    'rotate-cw': ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
    download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 21h16']
  };

  function body(d) {
    if (d.indexOf('circle:') === 0) {
      var c = d.split(':');
      return '<circle cx="' + c[1] + '" cy="' + c[2] + '" r="' + c[3] + '"/>';
    }
    return '<path d="' + d + '"/>';
  }

  window.icon = function (name, cls, size) {
    var paths = P[name] || P['file-text'];
    var s = size || 16;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' +
      (cls ? ' class="' + cls + '"' : '') + ' aria-hidden="true">' +
      paths.map(body).join('') + '</svg>';
  };

  window.hydrateIcons = function (root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      if (el.dataset.iconDone) return;
      el.dataset.iconDone = '1';
      el.innerHTML = icon(el.dataset.icon, el.dataset.iconClass || '', Number(el.dataset.iconSize || 16));
    });
  };
})();
