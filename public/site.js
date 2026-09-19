/* Carve Model — shared site behavior */
(function () {
  // Mobile menu toggle
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-menu-toggle]');
    if (t) {
      var m = document.getElementById('mobileMenu');
      if (m) m.classList.toggle('open');
    }
  });

  // Mobile "Services" submenu expand/collapse -- kept separate from the
  // Services link itself (a <button>, not part of the <a>) so the link
  // stays directly tappable to go to /scale-model-services while this
  // toggles the four service pages open/closed underneath it.
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-mobile-expand]');
    if (!b) return;
    var panel = document.getElementById(b.getAttribute('aria-controls'));
    if (!panel) return;
    var willOpen = panel.hidden;
    panel.hidden = !willOpen;
    b.setAttribute('aria-expanded', String(willOpen));
    b.classList.toggle('is-open', willOpen);
  });

  // Scroll reveal
  var io;
  function initReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window) || !els.length) {
      els.forEach(function (el) { el.classList.add('in'); });
      return;
    }
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          var el = en.target;
          var d = el.getAttribute('data-delay');
          if (d) el.style.transitionDelay = d + 'ms';
          el.classList.add('in');
          io.unobserve(el);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    els.forEach(function (el) { io.observe(el); });
  }

  // Header shadow on scroll
  function initHeader() {
    var h = document.querySelector('.site-header');
    if (!h) return;
    var onScroll = function () {
      if (window.scrollY > 8) h.classList.add('scrolled');
      else h.classList.remove('scrolled');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  if (document.readyState !== 'loading') { initReveal(); initHeader(); }
  else document.addEventListener('DOMContentLoaded', function () { initReveal(); initHeader(); });
})();
