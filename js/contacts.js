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

  function render() {
    var listEl = document.getElementById('contacts-list');
    var emptyEl = document.getElementById('contacts-empty');
    if (!listEl || !emptyEl) return;

    var contacts = SafeHer.api.getContacts();

    if (!contacts || contacts.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'flex';
      return;
    }

    emptyEl.style.display = 'none';

    var html = '';
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      var initial = (c.name || '?').charAt(0).toUpperCase();
      var relation = c.relation || 'Contact';

      html += '<div class="contact-card">' +
        '<div class="contact-left">' +
          '<div class="contact-avatar">' + escapeHtml(initial) + '</div>' +
          '<div class="contact-details">' +
            '<div class="contact-name-row">' +
              '<span class="contact-name">' + escapeHtml(c.name) + '</span>' +
              '<span class="contact-badge">' + escapeHtml(relation) + '</span>' +
              closeBadge +
            '</div>' +
            '<span class="contact-phone">' + escapeHtml(c.phone) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="contact-actions">' +
          '<a class="contact-action-btn call" href="tel:' + encodeURIComponent((c.phone || '').replace(/[^\d+]/g, '')) + '" aria-label="Call ' + escapeHtml(c.name) + '">' +
            '<span class="material-symbols-rounded">call</span>' +
          '</a>' +
          '<button class="contact-action-btn" onclick="SafeHer.contacts.openModal(' + Number(c.id) + ')" aria-label="Edit">' +
            '<span class="material-symbols-rounded">edit</span>' +
          '</button>' +
          '<button class="contact-action-btn" onclick="SafeHer.contacts.deleteContact(' + Number(c.id) + ')" aria-label="Delete">' +
            '<span class="material-symbols-rounded">delete</span>' +
          '</button>' +
        '</div>' +
      '</div>';
    }

    listEl.innerHTML = html;
  }

  function openModal(editId) {
    clearErrs();
    var modal = document.getElementById('contact-modal');
    var titleEl = document.getElementById('contact-modal-title');
    var idInput = document.getElementById('contact-edit-id');
    var nameInput = document.getElementById('contact-name');
    var phoneInput = document.getElementById('contact-phone');
    var emailInput = document.getElementById('contact-email');
    var relSelect = document.getElementById('contact-relation');

    if (!modal) return;

    if (editId) {
      var contacts = SafeHer.api.getContacts();
      var c = null;
      for (var i = 0; i < contacts.length; i++) {
        if (contacts[i].id === editId) { c = contacts[i]; break; }
      }
      if (c) {
        titleEl.textContent = 'Edit Contact';
        idInput.value = c.id;
        nameInput.value = c.name || '';
        phoneInput.value = c.phone || '';
        emailInput.value = c.email || '';
        relSelect.value = c.relation || 'Parent';
      }
    } else {
      titleEl.textContent = 'Add Contact';
      idInput.value = '';
      nameInput.value = '';
      phoneInput.value = '';
      emailInput.value = '';
      relSelect.value = 'Parent';
    }

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

    var name = nameInput.value.trim();
    var phone = phoneInput.value.trim();
    var email = emailInput.value.trim();
    var relation = relSelect.value;
    var editId = idInput.value ? Number(idInput.value) : null;

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
      // PUT /api/contacts/:id
      SafeHer.api.updateContact(editId, {
        name: name,
        phone: phone,
        email: email,
        relation: relation
      });
      SafeHer.toast('Contact updated');
    } else {
      // POST /api/contacts
      SafeHer.api.addContact({
        name: name,
        phone: phone,
        email: email,
        relation: relation
      });
      SafeHer.toast('Contact added');
    }

    closeModal();
    render();
  }

  function deleteContact(id) {
    if (confirm('Delete this contact?')) {
      // DELETE /api/contacts/:id
      SafeHer.api.removeContact(id);
      SafeHer.toast('Contact deleted');
      render();
    }
  }

  function init() {
    SafeHer.router.onShow('contacts', function() {
      render();
      if (SafeHer.api && SafeHer.api.getContacts) {
        SafeHer.api.getContacts(function(err, contacts) {
          if (!err && contacts) render();
        });
      }
    });
  }

  return {
    init: init,
    render: render,
    openModal: openModal,
    closeModal: closeModal,
    submitForm: submitForm,
    deleteContact: deleteContact
  };
})();
