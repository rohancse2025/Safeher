// js/contacts.js – emergency contacts management

SafeHer.contacts = (function() {
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setErr(id, msg) {
    var el = document.getElementById(id);
    if (el) el.textContent = msg;
  }

  function clearErrs() {
    setErr('err-contact-name', '');
    setErr('err-contact-phone', '');
    setErr('err-contact-email', '');
  }

  function render(explicitContacts) {
    var listEl = document.getElementById('contacts-list');
    var emptyEl = document.getElementById('contacts-empty');
    if (!listEl || !emptyEl) return;

    var contacts = (explicitContacts && Array.isArray(explicitContacts)) ? explicitContacts : SafeHer.api.getContacts();
    if ((!contacts || contacts.length === 0) && SafeHer.storage && SafeHer.storage.get) {
      contacts = SafeHer.storage.get('contacts') || [];
    }

    if (!contacts || contacts.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'flex';
      return;
    }

    emptyEl.style.display = 'none';

    var html = '';
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      if (!c) continue;
      if (!c.id) {
        c.id = 'cnt_' + i + '_' + (c.phone ? String(c.phone).replace(/\D/g, '') : Date.now());
      }
      var initial = (c.name || '?').charAt(0).toUpperCase();
      var relation = c.relation || c.relationship || 'Contact';
      var isClose = !!(c.is_close || c.close || (relation && /emergency|family|parent|spouse|close/i.test(relation)));
      var closeBadge = isClose ? ' <span class="contact-badge" style="background:#FFE4E6;color:#9E1B32;">Close</span>' : '';
      var contactKey = String(c.id || c.phone || i);

      html += '<div class="contact-card">' +
        '<div class="contact-left">' +
          '<div class="contact-avatar">' + escapeHtml(initial) + '</div>' +
          '<div class="contact-details">' +
            '<div class="contact-name-row">' +
              '<span class="contact-name">' + escapeHtml(c.name) + '</span>' +
              '<span class="contact-badge">' + escapeHtml(relation) + '</span>' +
              closeBadge +
            '</div>' +
            '<span class="contact-phone" style="display:flex;align-items:center;gap:4px;"><span class="material-symbols-rounded" style="color:#25D366;font-size:14px;">chat</span> ' + escapeHtml(c.phone) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="contact-actions">' +
          '<a class="contact-action-btn" href="https://wa.me/91' + encodeURIComponent((c.phone || '').replace(/\D/g, '')) + '" target="_blank" rel="noopener noreferrer" style="color:#25D366;" aria-label="WhatsApp ' + escapeHtml(c.name) + '">' +
            '<span class="material-symbols-rounded">chat</span>' +
          '</a>' +
          '<a class="contact-action-btn call" href="tel:' + encodeURIComponent((c.phone || '').replace(/[^\d+]/g, '')) + '" aria-label="Call ' + escapeHtml(c.name) + '">' +
            '<span class="material-symbols-rounded">call</span>' +
          '</a>' +
          '<button type="button" class="contact-action-btn" onclick="SafeHer.contacts.openModal(\'' + escapeHtml(contactKey) + '\')" aria-label="Edit ' + escapeHtml(c.name) + '">' +
            '<span class="material-symbols-rounded">edit</span>' +
          '</button>' +
          '<button type="button" class="contact-action-btn" onclick="SafeHer.contacts.deleteContact(\'' + escapeHtml(contactKey) + '\')" aria-label="Delete">' +
            '<span class="material-symbols-rounded">delete</span>' +
          '</button>' +
        '</div>' +
      '</div>';
    }

    listEl.innerHTML = html;
  }

  function openModal(editId) {
    clearErrs();
    var warnEl = document.getElementById('warn-contact-email');
    if (warnEl) warnEl.style.display = 'none';
    var modal = document.getElementById('contact-modal');
    var titleEl = document.getElementById('contact-modal-title');
    var idInput = document.getElementById('contact-edit-id');
    var nameInput = document.getElementById('contact-name');
    var phoneInput = document.getElementById('contact-phone');
    var emailInput = document.getElementById('contact-email');
    var relSelect = document.getElementById('contact-relation');

    if (!modal) return;

    if (editId !== undefined && editId !== null && String(editId).trim() !== '') {
      var editStr = String(editId).trim();
      var contacts = (SafeHer.api && SafeHer.api.getContacts) ? SafeHer.api.getContacts() : [];
      var rawAll = (SafeHer.storage && SafeHer.storage.get) ? (SafeHer.storage.get('contacts') || []) : [];
      var pool = (contacts && contacts.length > 0) ? contacts : rawAll;
      var c = null;

      for (var i = 0; i < pool.length; i++) {
        var it = pool[i];
        if (!it) continue;
        if (String(it.id) === editStr || String(it.phone) === editStr || String(i) === editStr) {
          c = it;
          break;
        }
      }
      if (!c && rawAll && rawAll.length > 0) {
        for (var j = 0; j < rawAll.length; j++) {
          var rIt = rawAll[j];
          if (!rIt) continue;
          if (String(rIt.id) === editStr || String(rIt.phone) === editStr || String(j) === editStr) {
            c = rIt;
            break;
          }
        }
      }

      if (c) {
        if (titleEl) titleEl.textContent = 'Edit Contact';
        if (idInput) idInput.value = c.id || editStr;
        if (nameInput) nameInput.value = c.name || '';
        if (phoneInput) phoneInput.value = c.phone || '';
        if (emailInput) emailInput.value = c.email || '';
        if (relSelect) relSelect.value = c.relation || c.relationship || 'Parent';
        modal.style.display = 'flex';
        return;
      }
    }

    if (titleEl) titleEl.textContent = 'Add Contact';
    if (idInput) idInput.value = '';
    if (nameInput) nameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (emailInput) emailInput.value = '';
    if (relSelect) relSelect.value = 'Parent';
    modal.style.display = 'flex';
  }

  function closeModal() {
    var modal = document.getElementById('contact-modal');
    if (modal) modal.style.display = 'none';
  }

  function submitForm() {
    var idInput = document.getElementById('contact-edit-id');
    var nameInput = document.getElementById('contact-name');
    var phoneInput = document.getElementById('contact-phone');
    var emailInput = document.getElementById('contact-email');
    var relSelect = document.getElementById('contact-relation');

    var name = nameInput ? nameInput.value.trim() : '';
    var phone = phoneInput ? phoneInput.value.trim() : '';
    var email = emailInput ? emailInput.value.trim() : '';
    var relation = relSelect ? relSelect.value : 'Parent';
    var editId = (idInput && idInput.value) ? idInput.value.trim() : null;

    clearErrs();
    var ok = true;

    if (!name) {
      setErr('err-contact-name', 'Name is required');
      ok = false;
    }

    if (!phone) {
      setErr('err-contact-phone', 'Phone is required');
      ok = false;
    } else if (!/^\d{10}$/.test(phone)) {
      setErr('err-contact-phone', 'Enter a valid 10-digit number');
      ok = false;
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErr('err-contact-email', 'Enter a valid email');
      ok = false;
    }

    if (!ok) return;

    if (editId) {
      // Update contact
      SafeHer.api.updateContact(editId, {
        name: name,
        phone: phone,
        email: email,
        relation: relation
      }, function(err, updated) {
        render();
        if (SafeHer.home && SafeHer.home.refresh) SafeHer.home.refresh();
      });
      SafeHer.toast('Contact updated');
    } else {
      // POST /api/contacts
      SafeHer.api.addContact({
        name: name,
        phone: phone,
        email: email,
        relation: relation
      }, function(err, created) {
        render();
        if (SafeHer.home && SafeHer.home.refresh) SafeHer.home.refresh();
      });
      SafeHer.toast('Contact added');
    }

    closeModal();
    render();
  }

  function deleteContact(id) {
    if (confirm('Delete this contact?')) {
      SafeHer.api.removeContact(id, function(err, ok) {
        render();
        if (SafeHer.home && SafeHer.home.refresh) SafeHer.home.refresh();
      });
      SafeHer.toast('Contact deleted');
      render();
    }
  }

  function init() {
    SafeHer.router.onShow('contacts', function() {
      render();
      if (SafeHer.api && SafeHer.api.getContacts) {
        SafeHer.api.getContacts(function(err, contacts) {
          if (!err && contacts) render(contacts);
        });
      }
    });
  }

  return {
    init: init,
    render: render,
    renderList: render,
    openModal: openModal,
    closeModal: closeModal,
    submitForm: submitForm,
    deleteContact: deleteContact
  };
})();
