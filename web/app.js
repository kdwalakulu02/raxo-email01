'use strict';
(() => {
  const $ = id => document.getElementById(id);

  const menu = document.querySelector('.menu-toggle');
  const nav = $('nav-links');
  if (menu && nav) {
    menu.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      menu.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', e => {
      if (e.target.closest('a')) { nav.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); }
    });
  }

  const tabs = [$('tab-basic'), $('tab-files')].filter(Boolean);
  const select = tab => tabs.forEach(t => {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  });
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      select(next); next.focus();
    });
  });

  const status = $('copy-status');
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const el = $(btn.dataset.copy);
    if (!el) return;
    const label = btn.textContent;
    try {
      await navigator.clipboard.writeText(el.textContent);
      btn.textContent = 'Copied';
      if (status) status.textContent = 'Copied to clipboard.';
    } catch {
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      if (status) status.textContent = 'Selected. Press Ctrl+C or Command+C to copy.';
    }
    setTimeout(() => { btn.textContent = label; }, 1600);
  });

  const form = $('generator-form');
  if (!form) return;
  const btn = $('submit-btn');
  const errorBox = $('generator-error');
  const showError = msg => { errorBox.textContent = msg; errorBox.hidden = false; };

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errorBox.hidden = true;
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      const res = await fetch('/api/forms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email: $('email-input').value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showError((data.error && data.error.message) || 'Could not generate a Form ID. Please try again.'); return; }
      $('form-id').textContent = data.form_id;
      $('action-url').textContent = data.action_url;
      $('management-token').textContent = data.management_token;
      $('snippet-basic-code').textContent = data.html_snippet;
      if (data.attachment_snippet) $('snippet-files-code').textContent = data.attachment_snippet;
      $('embed-status').textContent = 'Your form code is ready. It will start delivering after you click the activation link.';
      $('embed').classList.add('ready');
      $('result-container').hidden = false;
      $('result-container').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      showError('Network error. Please check your connection and try again.');
    } finally {
      btn.disabled = false; btn.textContent = 'Generate Form ID';
    }
  });
})();
