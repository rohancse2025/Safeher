// js/volunteer-apply.js – 5-Step Volunteer Registration Wizard & Application Status Screen

SafeHer.volunteerApply = (function() {
  var currentStep = 1;
  var totalSteps = 5;
  var applicationData = {
    full_name: '',
    dob: '',
    locality: '',
    motivation: '',
    availability_text: '',
    id_type: 'Voter ID',
    id_last4: '',
    references: [
      { name: '', phone: '', relation: '' },
      { name: '', phone: '', relation: '' }
    ],
    declaration_accepted: false,
    typed_signature: '',
    status: 'draft'
  };

  var trainingQuestions = [];
  var currentQuestionIdx = 0;
  var userAnswers = {};
  var trainingResult = null;
  var isUploadingId = false;
  var isUploadingSelfie = false;
  var idUploaded = false;
  var selfieUploaded = false;

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getAuthHeader() {
    var token = (SafeHer.api && SafeHer.api.getToken) ? SafeHer.api.getToken() : localStorage.getItem('token');
    return token ? { 'Authorization': 'Bearer ' + token } : {};
  }

  function getBaseUrl() {
    return (SafeHer.config && SafeHer.config.API_BASE_URL) ? SafeHer.config.API_BASE_URL : '';
  }

  // ─── Resize image before upload to at most maxDim (1600px) ─
  function resizeImage(file, maxDim, callback) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var img = new Image();
      img.onload = function() {
        var w = img.width;
        var h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round(h * maxDim / w);
            w = maxDim;
          } else {
            w = Math.round(w * maxDim / h);
            h = maxDim;
          }
        }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function(blob) {
          callback(blob);
        }, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ─── Fetch Application State from Server ───────────────────
  function loadApplication(callback) {
    var url = getBaseUrl() + '/api/volunteers/application';
    fetch(url, { headers: getAuthHeader() })
      .then(function(res) { return res.json(); })
      .then(function(json) {
        if (json.ok && json.data) {
          var d = json.data;
          applicationData.full_name = d.full_name || '';
          applicationData.dob = d.dob || '';
          applicationData.locality = d.locality || '';
          applicationData.motivation = d.motivation || '';
          applicationData.availability_text = d.availability_text || '';
          applicationData.id_type = d.id_type || 'Voter ID';
          applicationData.id_last4 = d.id_last4 || '';
          applicationData.status = d.status || 'draft';
          applicationData.level = d.level || 'provisional';
          applicationData.valid_until = d.valid_until || null;
          applicationData.reapply_after = d.reapply_after || null;
          applicationData.reject_reason_code = d.reject_reason_code || null;
          applicationData.training_score = d.training_score || null;
          applicationData.training_passed = !!d.training_passed_at;

          if (d.references && d.references.length > 0) {
            applicationData.references = [
              d.references[0] || { name: '', phone: '', relation: '' },
              d.references[1] || { name: '', phone: '', relation: '' }
            ];
          }
          idUploaded = !!d.id_image_uploaded;
          selfieUploaded = !!d.selfie_uploaded;
          if (callback) callback(null, applicationData);
        } else {
          if (callback) callback(json.error || 'Failed to load application');
        }
      })
      .catch(function(err) {
        if (callback) callback(err.message || 'Network error');
      });
  }

  // ─── Save Draft to Backend ────────────────────────────────
  function saveDraft(callback) {
    var url = getBaseUrl() + '/api/volunteers/application';
    var payload = {
      full_name: applicationData.full_name,
      dob: applicationData.dob,
      locality: applicationData.locality,
      id_type: applicationData.id_type,
      id_last4: applicationData.id_last4,
      motivation: applicationData.motivation,
      availability_text: applicationData.availability_text,
      declaration_accepted: !!applicationData.declaration_accepted,
      declaration_version: 'v1.0',
      typed_signature: applicationData.typed_signature,
      references: [
        {
          name: applicationData.references[0].name,
          phone: applicationData.references[0].phone,
          relation: applicationData.references[0].relation
        },
        {
          name: applicationData.references[1].name,
          phone: applicationData.references[1].phone,
          relation: applicationData.references[1].relation
        }
      ]
    };

    fetch(url, {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
      body: JSON.stringify(payload)
    })
      .then(function(res) { return res.json(); })
      .then(function(json) {
        if (json.ok) {
          if (callback) callback(null, json.data);
        } else {
          if (callback) callback(json.error || 'Failed to save draft');
        }
      })
      .catch(function(err) {
        if (callback) callback(err.message || 'Network error');
      });
  }

  // ─── Upload ID Image ──────────────────────────────────────
  function uploadIdImage(file, callback) {
    isUploadingId = true;
    renderStep(currentStep);
    resizeImage(file, 1600, function(blob) {
      var formData = new FormData();
      formData.append('id_image', blob, file.name || 'id_card.jpg');

      var url = getBaseUrl() + '/api/volunteers/application/id-image';
      fetch(url, {
        method: 'POST',
        headers: getAuthHeader(),
        body: formData
      })
        .then(function(res) { return res.json(); })
        .then(function(json) {
          isUploadingId = false;
          if (json.ok) {
            idUploaded = true;
            SafeHer.toast('Government ID uploaded successfully');
            if (callback) callback(null);
          } else {
            SafeHer.toast(json.error || 'Failed to upload ID photo');
            if (callback) callback(json.error);
          }
          renderStep(currentStep);
        })
        .catch(function(err) {
          isUploadingId = false;
          SafeHer.toast('Error uploading ID: ' + err.message);
          renderStep(currentStep);
          if (callback) callback(err.message);
        });
    });
  }

  // ─── Upload Live Selfie ───────────────────────────────────
  function uploadSelfie(file, callback) {
    isUploadingSelfie = true;
    renderStep(currentStep);
    resizeImage(file, 1600, function(blob) {
      var formData = new FormData();
      formData.append('selfie', blob, 'selfie.jpg');

      var url = getBaseUrl() + '/api/volunteers/application/selfie';
      fetch(url, {
        method: 'POST',
        headers: getAuthHeader(),
        body: formData
      })
        .then(function(res) { return res.json(); })
        .then(function(json) {
          isUploadingSelfie = false;
          if (json.ok) {
            selfieUploaded = true;
            SafeHer.toast('Live selfie uploaded successfully');
            if (callback) callback(null);
          } else {
            SafeHer.toast(json.error || 'Failed to upload selfie');
            if (callback) callback(json.error);
          }
          renderStep(currentStep);
        })
        .catch(function(err) {
          isUploadingSelfie = false;
          SafeHer.toast('Error uploading selfie: ' + err.message);
          renderStep(currentStep);
          if (callback) callback(err.message);
        });
    });
  }

  // ─── Fetch Training Questions ─────────────────────────────
  function loadTrainingQuestions(callback) {
    var url = getBaseUrl() + '/api/volunteers/training';
    fetch(url, { headers: getAuthHeader() })
      .then(function(res) { return res.json(); })
      .then(function(json) {
        if (json.ok && json.data && json.data.questions) {
          trainingQuestions = json.data.questions;
          if (callback) callback(null, json.data);
        } else {
          if (callback) callback(json.error || 'Could not load questions');
        }
      })
      .catch(function(err) {
        if (callback) callback(err.message);
      });
  }

  // ─── Submit Training Answers ──────────────────────────────
  function submitTraining(callback) {
    var url = getBaseUrl() + '/api/volunteers/training/submit';
    fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader()),
      body: JSON.stringify({ answers: userAnswers })
    })
      .then(function(res) { return res.json(); })
      .then(function(json) {
        trainingResult = json;
        if (json.ok && json.data && json.data.passed) {
          applicationData.training_passed = true;
          applicationData.training_score = json.data.score;
        }
        if (callback) callback(null, json);
      })
      .catch(function(err) {
        if (callback) callback(err.message);
      });
  }

  // ─── Final Submit Application ─────────────────────────────
  function submitApplication(callback) {
    var url = getBaseUrl() + '/api/volunteers/application/submit';
    fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader())
    })
      .then(function(res) { return res.json(); })
      .then(function(json) {
        if (json.ok) {
          SafeHer.toast('Application submitted');
          applicationData.status = 'submitted';
          if (callback) callback(null, json.data);
        } else {
          SafeHer.toast(json.error || 'Submission failed');
          if (callback) callback(json.error);
        }
      })
      .catch(function(err) {
        SafeHer.toast('Error submitting: ' + err.message);
        if (callback) callback(err.message);
      });
  }

  // ─── RENDER PROGRESS DOTS ─────────────────────────────────
  function renderProgressDots(activeStep) {
    var steps = ['Details', 'Identity', 'References', 'Training', 'Declaration'];
    var html = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; padding:0 4px;">';
    for (var i = 1; i <= totalSteps; i++) {
      var isCompleted = i < activeStep;
      var isActive = i === activeStep;
      var dotBg = isActive ? '#A80F3C' : (isCompleted ? '#2E7D32' : '#E0E0E0');
      var textColor = (isActive || isCompleted) ? '#FFFFFF' : '#777777';
      var labelColor = isActive ? '#A80F3C' : (isCompleted ? '#2E7D32' : '#888888');

      html += '<div style="display:flex; flex-direction:column; align-items:center; flex:1; position:relative;">';
      if (i > 1) {
        var lineBg = (i <= activeStep) ? '#A80F3C' : '#E0E0E0';
        html += '<div style="position:absolute; top:12px; left:-50%; width:100%; height:2px; background:' + lineBg + '; z-index:1;"></div>';
      }
      html += '<div style="width:24px; height:24px; border-radius:50%; background:' + dotBg + '; color:' + textColor + '; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; z-index:2; position:relative;">';
      html += isCompleted ? '✓' : i;
      html += '</div>';
      html += '<span style="font-size:10px; font-weight:600; color:' + labelColor + '; margin-top:4px; text-align:center;">' + steps[i - 1] + '</span>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ─── RENDER STEP 1: DETAILS ───────────────────────────────
  function renderStep1() {
    return (
      '<div class="settings-card" style="padding:16px; border:1px solid #E0E0E0; border-radius:8px; background:#FFFFFF;">' +
        '<div style="background:#EFF6FF; border:1px solid #BFDBFE; border-radius:8px; padding:12px 14px; margin-bottom:14px; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">' +
          '<div>' +
            '<strong style="color:#1D4ED8; font-size:13px; display:block;">⚡ Quick Testing / Demo Profile</strong>' +
            '<span style="color:#1E40AF; font-size:12px;">Prefill all 5 application steps in 1 tap, submit for review, and approve in admin portal.</span>' +
          '</div>' +
          '<button type="button" class="btn btn-secondary" onclick="SafeHer.volunteerApply.fillDemoProfile()" style="padding:8px 14px; font-size:12px; font-weight:700; background:#2563EB; color:#FFF; border:none; border-radius:6px; cursor:pointer;">' +
            '⚡ 1-Tap Auto-Fill Demo' +
          '</button>' +
        '</div>' +
        '<h3 style="font-size:16px; font-weight:700; color:#A80F3C; margin:0 0 4px;">1. Personal Details</h3>' +
        '<p style="font-size:12px; color:#666666; margin:0 0 14px;">Please provide your basic contact and residency information.</p>' +

        '<div style="background:#FCEFF3; border:1px solid #F8BBD0; border-radius:6px; padding:10px 12px; margin-bottom:14px; font-size:12px; color:#A80F3C; font-weight:600;">' +
          '⚠️ Age Requirement: Community volunteers must be 18 years of age or older.' +
        '</div>' +

        '<div style="margin-bottom:12px;">' +
          '<label style="display:block; font-size:12px; font-weight:600; color:#444444; margin-bottom:4px;">Full Name *</label>' +
          '<input type="text" id="wiz-full-name" class="form-input" placeholder="e.g. Sunita Verma" value="' + escapeHtml(applicationData.full_name) + '" style="width:100%; padding:10px; font-size:14px; border:1px solid #CCCCCC; border-radius:6px;" />' +
        '</div>' +

        '<div style="margin-bottom:12px;">' +
          '<label style="display:block; font-size:12px; font-weight:600; color:#444444; margin-bottom:4px;">Date of Birth (YYYY-MM-DD) *</label>' +
          '<input type="date" id="wiz-dob" class="form-input" value="' + escapeHtml(applicationData.dob) + '" style="width:100%; padding:10px; font-size:14px; border:1px solid #CCCCCC; border-radius:6px;" />' +
        '</div>' +

        '<div style="margin-bottom:12px;">' +
          '<label style="display:block; font-size:12px; font-weight:600; color:#444444; margin-bottom:4px;">Locality / Neighborhood *</label>' +
          '<input type="text" id="wiz-locality" class="form-input" placeholder="e.g. Indiranagar, Bengaluru" value="' + escapeHtml(applicationData.locality) + '" style="width:100%; padding:10px; font-size:14px; border:1px solid #CCCCCC; border-radius:6px;" />' +
        '</div>' +

        '<div style="margin-bottom:12px;">' +
          '<label style="display:block; font-size:12px; font-weight:600; color:#444444; margin-bottom:4px;">Motivation *</label>' +
          '<textarea id="wiz-motivation" class="form-input" rows="3" placeholder="Why do you wish to join the community safety volunteer network?" style="width:100%; padding:10px; font-size:13px; border:1px solid #CCCCCC; border-radius:6px;">' + escapeHtml(applicationData.motivation) + '</textarea>' +
        '</div>' +

        '<div style="margin-bottom:16px;">' +
          '<label style="display:block; font-size:12px; font-weight:600; color:#444444; margin-bottom:4px;">Availability *</label>' +
          '<input type="text" id="wiz-availability" class="form-input" placeholder="e.g. Evenings 7 PM - 11 PM and weekends" value="' + escapeHtml(applicationData.availability_text) + '" style="width:100%; padding:10px; font-size:13px; border:1px solid #CCCCCC; border-radius:6px;" />' +
        '</div>' +

        '<div style="display:flex; justify-content:flex-end;">' +
          '<button type="button" class="btn btn-crimson" onclick="SafeHer.volunteerApply.goNext()" style="padding:10px 24px; font-size:13px; font-weight:700;">Next: Identity →</button>' +
        '</div>' +
      '</div>'
    );
  }

  // ─── RENDER STEP 2: IDENTITY ──────────────────────────────
  function renderStep2() {
    var idTypes = ['Voter ID', 'Driving Licence', 'College ID', 'Passport', 'Other'];
    var selectHtml = '<select id="wiz-id-type" class="form-input" style="width:100%; padding:10px; font-size:14px; border:1px solid #CCCCCC; border-radius:6px; margin-bottom:12px;">';
    idTypes.forEach(function(t) {
      selectHtml += '<option value="' + t + '"' + (applicationData.id_type === t ? ' selected' : '') + '>' + t + '</option>';
    });
    selectHtml += '</select>';

    return (
      '<div class="settings-card" style="padding:16px; border:1px solid #E0E0E0; border-radius:8px; background:#FFFFFF;">' +
        '<h3 style="font-size:16px; font-weight:700; color:#A80F3C; margin:0 0 4px;">2. Identity Verification</h3>' +
        '<p style="font-size:12px; color:#666666; margin:0 0 14px;">Select your government or college photo ID and enter only the final 4 digits.</p>' +

        '<div style="background:#FFF9C4; border:1px solid #FFF59D; border-radius:6px; padding:10px 12px; margin-bottom:14px; font-size:12px; color:#795548; font-weight:600;">' +
          '🔒 Do not enter your full ID number. We only collect the last 4 digits for verification.' +
        '</div>' +

        '<div style="margin-bottom:12px;">' +
          '<label style="display:block; font-size:12px; font-weight:600; color:#444444; margin-bottom:4px;">ID Document Type *</label>' +
          selectHtml +
        '</div>' +

        '<div style="margin-bottom:14px;">' +
          '<label style="display:block; font-size:12px; font-weight:600; color:#444444; margin-bottom:4px;">Last 4 Digits / Characters *</label>' +
          '<input type="text" id="wiz-id-last4" maxlength="4" class="form-input" placeholder="e.g. 4821" value="' + escapeHtml(applicationData.id_last4) + '" style="width:100%; padding:10px; font-size:14px; font-family:monospace; letter-spacing:2px; border:1px solid #CCCCCC; border-radius:6px;" />' +
        '</div>' +

        '<div style="margin-bottom:14px; border:1px dashed #BDBDBD; border-radius:6px; padding:12px; background:#FAFAFA;">' +
          '<label style="display:block; font-size:12px; font-weight:700; color:#222222; margin-bottom:4px;">Government / College ID Photo *</label>' +
          '<p style="font-size:11px; color:#666666; margin:0 0 8px;">Upload a clear photo of your ID (automatically resized to $\le 1600$px).</p>' +
          '<input type="file" id="wiz-id-file" accept="image/jpeg,image/png" style="font-size:12px;" onchange="SafeHer.volunteerApply.handleIdFile(this.files[0])" />' +
          (isUploadingId ? '<p style="color:#A80F3C; font-size:11px; margin-top:4px;">Resizing and uploading photo...</p>' : '') +
          (idUploaded ? '<p style="color:#2E7D32; font-size:11px; font-weight:600; margin-top:4px;">✓ ID Photo uploaded on file</p>' : '') +
          '<p style="font-size:10px; color:#888888; margin:6px 0 0;">Privacy Notice: Your ID document is stored securely in private storage and permanently deleted 7 days after the review decision.</p>' +
        '</div>' +

        '<div style="margin-bottom:16px; border:1px dashed #BDBDBD; border-radius:6px; padding:12px; background:#FAFAFA;">' +
          '<label style="display:block; font-size:12px; font-weight:700; color:#222222; margin-bottom:4px;">Live Verification Selfie *</label>' +
          '<p style="font-size:11px; color:#666666; margin:0 0 8px;">Take a live photo of yourself using your front camera.</p>' +
          '<input type="file" id="wiz-selfie-file" accept="image/*" capture="user" style="font-size:12px;" onchange="SafeHer.volunteerApply.handleSelfieFile(this.files[0])" />' +
          (isUploadingSelfie ? '<p style="color:#A80F3C; font-size:11px; margin-top:4px;">Uploading selfie...</p>' : '') +
          (selfieUploaded ? '<p style="color:#2E7D32; font-size:11px; font-weight:600; margin-top:4px;">✓ Live selfie uploaded on file</p>' : '') +
        '</div>' +

        '<div style="display:flex; justify-content:space-between;">' +
          '<button type="button" class="btn btn-outline" onclick="SafeHer.volunteerApply.goBack()" style="padding:10px 18px; font-size:13px;">← Back</button>' +
          '<button type="button" class="btn btn-crimson" onclick="SafeHer.volunteerApply.goNext()" style="padding:10px 24px; font-size:13px; font-weight:700;">Next: References →</button>' +
        '</div>' +
      '</div>'
    );
  }

  // ─── RENDER STEP 3: REFERENCES ────────────────────────────
  function renderStep3() {
    var r1 = applicationData.references[0] || { name: '', phone: '', relation: '' };
    var r2 = applicationData.references[1] || { name: '', phone: '', relation: '' };

    return (
      '<div class="settings-card" style="padding:16px; border:1px solid #E0E0E0; border-radius:8px; background:#FFFFFF;">' +
        '<h3 style="font-size:16px; font-weight:700; color:#A80F3C; margin:0 0 4px;">3. Character References</h3>' +
        '<p style="font-size:12px; color:#666666; margin:0 0 14px;">Provide 2 personal or professional references. A reviewer will contact them to verify your identity.</p>' +

        '<div style="background:#FCEFF3; border:1px solid #F8BBD0; border-radius:6px; padding:10px 12px; margin-bottom:14px; font-size:12px; color:#A80F3C;">' +
          '📞 Notice: Reference phone numbers must differ from each other and cannot be your own phone number.' +
        '</div>' +

        '<div style="margin-bottom:14px; padding:12px; border:1px solid #E0E0E0; border-radius:6px; background:#FAFAFA;">' +
          '<strong style="font-size:13px; color:#222222; display:block; margin-bottom:8px;">Reference 1</strong>' +
          '<input type="text" id="wiz-ref1-name" class="form-input" placeholder="Full Name *" value="' + escapeHtml(r1.name) + '" style="width:100%; padding:8px 10px; font-size:13px; margin-bottom:6px; border:1px solid #CCCCCC; border-radius:6px;" />' +
          '<input type="tel" id="wiz-ref1-phone" class="form-input" placeholder="10-digit Mobile Phone *" value="' + escapeHtml(r1.phone) + '" style="width:100%; padding:8px 10px; font-size:13px; margin-bottom:6px; border:1px solid #CCCCCC; border-radius:6px;" />' +
          '<input type="text" id="wiz-ref1-rel" class="form-input" placeholder="Relationship (e.g. Mentor, Colleague, Neighbor)" value="' + escapeHtml(r1.relation) + '" style="width:100%; padding:8px 10px; font-size:13px; border:1px solid #CCCCCC; border-radius:6px;" />' +
        '</div>' +

        '<div style="margin-bottom:16px; padding:12px; border:1px solid #E0E0E0; border-radius:6px; background:#FAFAFA;">' +
          '<strong style="font-size:13px; color:#222222; display:block; margin-bottom:8px;">Reference 2</strong>' +
          '<input type="text" id="wiz-ref2-name" class="form-input" placeholder="Full Name *" value="' + escapeHtml(r2.name) + '" style="width:100%; padding:8px 10px; font-size:13px; margin-bottom:6px; border:1px solid #CCCCCC; border-radius:6px;" />' +
          '<input type="tel" id="wiz-ref2-phone" class="form-input" placeholder="10-digit Mobile Phone *" value="' + escapeHtml(r2.phone) + '" style="width:100%; padding:8px 10px; font-size:13px; margin-bottom:6px; border:1px solid #CCCCCC; border-radius:6px;" />' +
          '<input type="text" id="wiz-ref2-rel" class="form-input" placeholder="Relationship (e.g. Teacher, Employer)" value="' + escapeHtml(r2.relation) + '" style="width:100%; padding:8px 10px; font-size:13px; border:1px solid #CCCCCC; border-radius:6px;" />' +
        '</div>' +

        '<div style="display:flex; justify-content:space-between;">' +
          '<button type="button" class="btn btn-outline" onclick="SafeHer.volunteerApply.goBack()" style="padding:10px 18px; font-size:13px;">← Back</button>' +
          '<button type="button" class="btn btn-crimson" onclick="SafeHer.volunteerApply.goNext()" style="padding:10px 24px; font-size:13px; font-weight:700;">Next: Safety Training →</button>' +
        '</div>' +
      '</div>'
    );
  }

  // ─── RENDER STEP 4: TRAINING (1 Question at a time) ────────
  function renderStep4() {
    if (applicationData.training_passed) {
      return (
        '<div class="settings-card" style="padding:16px; border:1px solid #E0E0E0; border-radius:8px; background:#FFFFFF;">' +
          '<h3 style="font-size:16px; font-weight:700; color:#2E7D32; margin:0 0 4px;">4. Safety Training: Passed ✓</h3>' +
          '<p style="font-size:13px; color:#444444; margin:10px 0;">You have successfully completed the 8-question volunteer safety training with a score of ' + (applicationData.training_score || 100) + '%.</p>' +
          '<div style="display:flex; justify-content:space-between; margin-top:16px;">' +
            '<button type="button" class="btn btn-outline" onclick="SafeHer.volunteerApply.goBack()" style="padding:10px 18px; font-size:13px;">← Back</button>' +
            '<button type="button" class="btn btn-crimson" onclick="SafeHer.volunteerApply.goNext()" style="padding:10px 24px; font-size:13px; font-weight:700;">Next: Declaration →</button>' +
          '</div>' +
        '</div>'
      );
    }

    if (!trainingQuestions || trainingQuestions.length === 0) {
      return (
        '<div class="settings-card" style="padding:16px; border:1px solid #E0E0E0; border-radius:8px; background:#FFFFFF;">' +
          '<h3 style="font-size:16px; font-weight:700; color:#A80F3C; margin:0 0 4px;">4. Volunteer Safety Training</h3>' +
          '<p style="font-size:13px; color:#666666;">Loading questions from safety database...</p>' +
        '</div>'
      );
    }

    var q = trainingQuestions[currentQuestionIdx];
    var optionsHtml = '';
    var letters = ['A', 'B', 'C', 'D'];
    q.options.forEach(function(opt, idx) {
      var isChecked = userAnswers[q.id] === idx;
      optionsHtml += (
        '<label style="display:flex; align-items:flex-start; padding:10px; margin-bottom:8px; border:1px solid ' + (isChecked ? '#A80F3C' : '#E0E0E0') + '; border-radius:6px; background:' + (isChecked ? '#FCEFF3' : '#FAFAFA') + '; cursor:pointer;">' +
          '<input type="radio" name="wiz_q_' + q.id + '" value="' + idx + '"' + (isChecked ? ' checked' : '') + ' onchange="SafeHer.volunteerApply.selectAnswer(' + q.id + ', ' + idx + ')" style="margin-top:3px; margin-right:10px;" />' +
          '<span style="font-size:13px; color:#222222; line-height:1.4;"><strong>' + letters[idx] + '.</strong> ' + escapeHtml(opt) + '</span>' +
        '</label>'
      );
    });

    var isLastQuestion = currentQuestionIdx === trainingQuestions.length - 1;

    return (
      '<div class="settings-card" style="padding:16px; border:1px solid #E0E0E0; border-radius:8px; background:#FFFFFF;">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">' +
          '<h3 style="font-size:16px; font-weight:700; color:#A80F3C; margin:0;">4. Safety Training</h3>' +
          '<span style="font-size:12px; font-weight:700; color:#777777;">Question ' + (currentQuestionIdx + 1) + ' of ' + trainingQuestions.length + '</span>' +
        '</div>' +
        '<p style="font-size:14px; font-weight:600; color:#111111; margin:0 0 14px; line-height:1.4;">' + escapeHtml(q.question) + '</p>' +
        '<div style="margin-bottom:16px;">' + optionsHtml + '</div>' +

        '<div style="display:flex; justify-content:space-between;">' +
          (currentQuestionIdx > 0
            ? '<button type="button" class="btn btn-outline" onclick="SafeHer.volunteerApply.prevQuestion()" style="padding:8px 16px; font-size:12px;">← Previous</button>'
            : '<button type="button" class="btn btn-outline" onclick="SafeHer.volunteerApply.goBack()" style="padding:8px 16px; font-size:12px;">← Back</button>') +
          (isLastQuestion
            ? '<button type="button" class="btn btn-crimson" onclick="SafeHer.volunteerApply.submitTrainingAnswers()" style="padding:8px 20px; font-size:13px; font-weight:700;">Score Answers →</button>'
            : '<button type="button" class="btn btn-crimson" onclick="SafeHer.volunteerApply.nextQuestion()" style="padding:8px 20px; font-size:13px; font-weight:700;">Next Question →</button>') +
        '</div>' +
      '</div>'
    );
  }

  // ─── RENDER STEP 5: DECLARATION & SIGNATURE ───────────────
  function renderStep5() {
    return (
      '<div class="settings-card" style="padding:16px; border:1px solid #E0E0E0; border-radius:8px; background:#FFFFFF;">' +
        '<h3 style="font-size:16px; font-weight:700; color:#A80F3C; margin:0 0 4px;">5. Code of Conduct & Declaration</h3>' +
        '<p style="font-size:12px; color:#666666; margin:0 0 12px;">Every community responder must abide by these strict safety guidelines.</p>' +

        '<div style="background:#FAFAFA; border:1px solid #E0E0E0; border-radius:6px; padding:12px; font-size:12px; color:#333333; line-height:1.5; margin-bottom:14px; max-height:200px; overflow-y:auto;">' +
          '<ol style="margin:0; padding-left:18px;">' +
            '<li style="margin-bottom:6px;">Always call 112 first and never confront anyone directly.</li>' +
            '<li style="margin-bottom:6px;">If the person is with someone threatening, stay at a distance and call 112.</li>' +
            '<li style="margin-bottom:6px;">Never post the person\'s location, photo, or story on social media.</li>' +
            '<li style="margin-bottom:6px;">Never contact the person afterwards without their clear consent.</li>' +
            '<li style="margin-bottom:6px;">If you are alone in an unsafe place, use "Can\'t help" and do not go.</li>' +
            '<li style="margin-bottom:6px;">A silent-mode alert (screen dark, no sound) is high risk: call 112 and do not call or message her.</li>' +
            '<li style="margin-bottom:6px;">Never go alone with her to a private place or vehicle unless she asks and it is safe.</li>' +
            '<li style="margin-bottom:0;">Your data is used only to verify you and to match you with nearby alerts.</li>' +
          '</ol>' +
        '</div>' +

        '<div style="margin-bottom:12px;">' +
          '<label style="display:flex; align-items:flex-start; font-size:13px; color:#222222; cursor:pointer;">' +
            '<input type="checkbox" id="wiz-decl-check"' + (applicationData.declaration_accepted ? ' checked' : '') + ' style="margin-top:2px; margin-right:8px;" />' +
            '<span>I accept the SafeHer Volunteer Code of Conduct and solemnly declare that all information provided is accurate and truthful.</span>' +
          '</label>' +
        '</div>' +

        '<div style="margin-bottom:16px;">' +
          '<label style="display:block; font-size:12px; font-weight:600; color:#444444; margin-bottom:4px;">Typed Signature (Must exactly match full name: "' + escapeHtml(applicationData.full_name) + '") *</label>' +
          '<input type="text" id="wiz-signature" class="form-input" placeholder="Type your full name" value="' + escapeHtml(applicationData.typed_signature) + '" style="width:100%; padding:10px; font-size:14px; border:1px solid #CCCCCC; border-radius:6px;" />' +
        '</div>' +

        '<div style="display:flex; justify-content:space-between;">' +
          '<button type="button" class="btn btn-outline" onclick="SafeHer.volunteerApply.goBack()" style="padding:10px 18px; font-size:13px;">← Back</button>' +
          '<button type="button" class="btn btn-crimson" onclick="SafeHer.volunteerApply.submitFinal()" style="padding:10px 24px; font-size:13px; font-weight:700;">Submit Application ✓</button>' +
        '</div>' +
      '</div>'
    );
  }

  // ─── RENDER APPLICATION STATUS SCREEN ─────────────────────
  function renderStatusScreen() {
    var st = applicationData.status || 'submitted';
    var steps = [
      { key: 'submitted', label: '1. Submitted' },
      { key: 'in_review', label: '2. Under review' },
      { key: 'interview', label: '3. Interview' },
      { key: 'decision', label: '4. Decision' }
    ];

    var activeIdx = 0;
    if (st === 'submitted') activeIdx = 0;
    else if (st === 'in_review') activeIdx = 1;
    else if (st === 'approved' || st === 'rejected' || st === 'suspended' || st === 'expired') activeIdx = 3;

    var stepsHtml = '<div style="display:flex; justify-content:space-between; margin-bottom:20px; padding:0 4px;">';
    steps.forEach(function(s, idx) {
      var isDone = idx < activeIdx || (idx === 3 && st === 'approved');
      var isCurrent = idx === activeIdx && st !== 'approved';
      var dotColor = isDone ? '#2E7D32' : (isCurrent ? '#A80F3C' : '#BDBDBD');
      var labelColor = isDone ? '#2E7D32' : (isCurrent ? '#A80F3C' : '#777777');

      stepsHtml += '<div style="display:flex; flex-direction:column; align-items:center; flex:1; position:relative;">';
      if (idx > 0) {
        var lineBg = (idx <= activeIdx) ? dotColor : '#E0E0E0';
        stepsHtml += '<div style="position:absolute; top:12px; left:-50%; width:100%; height:2px; background:' + lineBg + '; z-index:1;"></div>';
      }
      stepsHtml += '<div style="width:24px; height:24px; border-radius:50%; background:' + dotColor + '; color:#FFF; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; z-index:2; position:relative;">';
      stepsHtml += isDone ? '✓' : (idx + 1);
      stepsHtml += '</div>';
      stepsHtml += '<span style="font-size:10px; font-weight:600; color:' + labelColor + '; margin-top:4px; text-align:center;">' + s.label + '</span>';
      stepsHtml += '</div>';
    });
    stepsHtml += '</div>';

    var statusCard = '';
    if (st === 'submitted') {
      statusCard = (
        '<div style="background:#E3F2FD; border:1px solid #90CAF9; border-radius:8px; padding:16px; margin-bottom:16px;">' +
          '<h4 style="color:#1565C0; margin:0 0 6px; font-size:15px; font-weight:700;">Application Submitted — Pending Admin Approval</h4>' +
          '<p style="color:#0D47A1; margin:0 0 12px; font-size:13px; line-height:1.4;">Your volunteer application is awaiting administrative review. Once approved, the "Available to help" toggle will unlock immediately.</p>' +
          '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
            '<a href="admin.html" target="_blank" class="btn btn-crimson" style="display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700; text-decoration:none; padding:8px 14px; border-radius:6px;">' +
              '<span class="material-symbols-rounded" style="font-size:16px;">admin_panel_settings</span>Open Admin Portal to Approve →' +
            '</a>' +
            '<button type="button" class="btn btn-outline" onclick="SafeHer.volunteerApply.checkApprovalStatus()" style="font-size:12px; padding:8px 14px;">' +
              '🔄 Check Approval Status' +
            '</button>' +
          '</div>' +
        '</div>'
      );
    } else if (st === 'in_review') {
      statusCard = (
        '<div style="background:#FFF9C4; border:1px solid #FFF59D; border-radius:8px; padding:16px; margin-bottom:16px;">' +
          '<h4 style="color:#F57F17; margin:0 0 6px; font-size:15px; font-weight:700;">Under Review / Additional Information</h4>' +
          '<p style="color:#5D4037; margin:0 0 8px; font-size:13px; line-height:1.4;">Your application is currently being evaluated by our volunteer safety review team. Please ensure your mobile phone is reachable for verification.</p>' +
          '<button type="button" class="btn btn-outline" onclick="SafeHer.volunteerApply.startWizard(1)" style="font-size:12px; padding:6px 14px;">Update Application Draft</button>' +
        '</div>'
      );
    } else if (st === 'rejected') {
      var reasonMap = {
        'id_mismatch': 'Government ID document details did not match declared applicant identity.',
        'references_negative': 'Negative feedback received from character references during verification calls.',
        'references_unreachable': 'Character references could not be reached after multiple verification attempts.',
        'training_not_passed': 'Volunteer safety training was not completed or failed minimum score requirements.',
        'incomplete': 'Application packet or verification documentation was incomplete.',
        'safety_concern': 'Safety or behavioral concern identified during administrative review.',
        'underage': 'Applicant is under the mandatory 18-year age requirement.',
        'other': 'Application did not meet community safety verification standards.'
      };
      var reasonText = reasonMap[applicationData.reject_reason_code] || applicationData.reject_reason_code || 'Application review did not meet verification standards.';

      statusCard = (
        '<div style="background:#FFEBEE; border:1px solid #FFCDD2; border-radius:8px; padding:16px; margin-bottom:16px;">' +
          '<h4 style="color:#C62828; margin:0 0 6px; font-size:15px; font-weight:700;">Application Rejected</h4>' +
          '<p style="color:#B71C1C; margin:0 0 8px; font-size:13px; line-height:1.4;"><strong>Reviewer Reason:</strong> ' + escapeHtml(reasonText) + '</p>' +
          (applicationData.reapply_after ? '<p style="color:#555555; font-size:12px; margin:0 0 8px;"><strong>Reapplication Date:</strong> You can submit a new volunteer application starting on ' + escapeHtml(applicationData.reapply_after) + '.</p>' : '') +
        '</div>'
      );
    } else if (st === 'suspended') {
      statusCard = (
        '<div style="background:#FFEBEE; border:1px solid #FFCDD2; border-radius:8px; padding:16px; margin-bottom:16px;">' +
          '<h4 style="color:#C62828; margin:0 0 6px; font-size:15px; font-weight:700;">Volunteer Account Suspended</h4>' +
          '<p style="color:#B71C1C; margin:0; font-size:13px; line-height:1.4;">Your volunteer privileges have been temporarily suspended due to a safety incident report. An administrative reviewer is currently investigating the report.</p>' +
        '</div>'
      );
    } else if (st === 'expired') {
      statusCard = (
        '<div style="background:#FFF3E0; border:1px solid #FFE0B2; border-radius:8px; padding:16px; margin-bottom:16px;">' +
          '<h4 style="color:#E65100; margin:0 0 6px; font-size:15px; font-weight:700;">Approval Validity Expired</h4>' +
          '<p style="color:#BF360C; margin:0 0 10px; font-size:13px; line-height:1.4;">Your 12-month volunteer safety approval period has ended. Please re-verify your information to resume active volunteer status.</p>' +
          '<button type="button" class="btn btn-crimson" onclick="SafeHer.volunteerApply.startWizard(1)" style="font-size:12px; padding:6px 14px;">Re-verify Volunteer Profile</button>' +
        '</div>'
      );
    }

    return (
      '<div class="settings-card" style="padding:16px; border:1px solid #E0E0E0; border-radius:8px; background:#FFFFFF;">' +
        '<h3 style="font-size:16px; font-weight:700; color:#A80F3C; margin:0 0 14px;">Application Status</h3>' +
        stepsHtml +
        statusCard +
        '<div style="background:#F5F5F5; border-radius:6px; padding:10px 12px; font-size:11px; color:#666666; margin-top:12px;">' +
          'ℹ️ Note: Volunteer safety approvals expire automatically after 12 months, requiring annual verification renewal.' +
        '</div>' +
      '</div>'
    );
  }

  // ─── RENDER DISPATCHER ────────────────────────────────────
  function renderStep(step) {
    var container = document.getElementById('volunteer-app-container');
    if (!container) return;

    var st = applicationData.status || 'draft';
    if (st === 'approved') {
      container.innerHTML = '';
      return;
    }

    if (st === 'submitted' || st === 'in_review' || st === 'rejected' || st === 'suspended' || st === 'expired') {
      container.innerHTML = renderStatusScreen();
      return;
    }

    // Otherwise render 5-step wizard
    var html = renderProgressDots(step);
    if (step === 1) html += renderStep1();
    else if (step === 2) html += renderStep2();
    else if (step === 3) html += renderStep3();
    else if (step === 4) html += renderStep4();
    else if (step === 5) html += renderStep5();

    container.innerHTML = html;
  }

  // ─── WIZARD NAVIGATION & VALIDATION ───────────────────────
  function goNext() {
    if (currentStep === 1) {
      var nameEl = document.getElementById('wiz-full-name');
      var dobEl = document.getElementById('wiz-dob');
      var locEl = document.getElementById('wiz-locality');
      var motEl = document.getElementById('wiz-motivation');
      var availEl = document.getElementById('wiz-availability');

      applicationData.full_name = nameEl ? nameEl.value.trim() : '';
      applicationData.dob = dobEl ? dobEl.value.trim() : '';
      applicationData.locality = locEl ? locEl.value.trim() : '';
      applicationData.motivation = motEl ? motEl.value.trim() : '';
      applicationData.availability_text = availEl ? availEl.value.trim() : '';

      if (!applicationData.full_name || applicationData.full_name.length < 2) {
        SafeHer.toast('Please enter your full name (at least 2 characters)');
        return;
      }
      if (!applicationData.dob) {
        SafeHer.toast('Please enter your date of birth');
        return;
      }
      // Validate 18+
      var dob = new Date(applicationData.dob);
      var today = new Date();
      var age = today.getFullYear() - dob.getFullYear();
      var m = today.getMonth() - dob.getMonth();
      if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
        age--;
      }
      if (age < 18) {
        SafeHer.toast('Volunteers must be 18 years of age or older');
        return;
      }
      if (!applicationData.locality) {
        SafeHer.toast('Please enter your neighborhood / locality');
        return;
      }
      if (!applicationData.motivation || applicationData.motivation.length < 10) {
        SafeHer.toast('Please write a brief motivation (at least 10 characters)');
        return;
      }
      if (!applicationData.availability_text) {
        SafeHer.toast('Please describe your general availability');
        return;
      }

      saveDraft(function(err) {
        if (!err) {
          currentStep = 2;
          renderStep(currentStep);
        } else {
          SafeHer.toast(err);
        }
      });
    } else if (currentStep === 2) {
      var idTypeEl = document.getElementById('wiz-id-type');
      var last4El = document.getElementById('wiz-id-last4');

      applicationData.id_type = idTypeEl ? idTypeEl.value : 'Voter ID';
      applicationData.id_last4 = last4El ? last4El.value.trim() : '';

      if (!applicationData.id_last4 || applicationData.id_last4.length !== 4) {
        SafeHer.toast('Enter exactly the last 4 characters of your ID');
        return;
      }
      if (!idUploaded) {
        SafeHer.toast('Please upload a photo of your ID document');
        return;
      }
      if (!selfieUploaded) {
        SafeHer.toast('Please take and upload a live selfie');
        return;
      }

      saveDraft(function(err) {
        if (!err) {
          currentStep = 3;
          renderStep(currentStep);
        } else {
          SafeHer.toast(err);
        }
      });
    } else if (currentStep === 3) {
      var n1 = document.getElementById('wiz-ref1-name');
      var p1 = document.getElementById('wiz-ref1-phone');
      var r1 = document.getElementById('wiz-ref1-rel');
      var n2 = document.getElementById('wiz-ref2-name');
      var p2 = document.getElementById('wiz-ref2-phone');
      var r2 = document.getElementById('wiz-ref2-rel');

      applicationData.references[0] = {
        name: n1 ? n1.value.trim() : '',
        phone: p1 ? p1.value.trim() : '',
        relation: r1 ? r1.value.trim() : ''
      };
      applicationData.references[1] = {
        name: n2 ? n2.value.trim() : '',
        phone: p2 ? p2.value.trim() : '',
        relation: r2 ? r2.value.trim() : ''
      };

      if (!applicationData.references[0].name || !applicationData.references[0].phone) {
        SafeHer.toast('Please fill in Name and Phone for Reference 1');
        return;
      }
      if (!applicationData.references[1].name || !applicationData.references[1].phone) {
        SafeHer.toast('Please fill in Name and Phone for Reference 2');
        return;
      }
      if (applicationData.references[0].phone === applicationData.references[1].phone) {
        SafeHer.toast('The two references must have different phone numbers');
        return;
      }

      saveDraft(function(err) {
        if (!err) {
          currentStep = 4;
          if (!applicationData.training_passed) {
            loadTrainingQuestions(function() {
              renderStep(currentStep);
            });
          } else {
            renderStep(currentStep);
          }
        } else {
          SafeHer.toast(err);
        }
      });
    } else if (currentStep === 4) {
      if (!applicationData.training_passed) {
        SafeHer.toast('You must pass the 8-question safety training before proceeding');
        return;
      }
      currentStep = 5;
      renderStep(currentStep);
    }
  }

  function goBack() {
    if (currentStep > 1) {
      currentStep--;
      renderStep(currentStep);
    }
  }

  function handleIdFile(file) {
    if (!file) return;
    uploadIdImage(file, function(err) {
      if (!err) idUploaded = true;
    });
  }

  function handleSelfieFile(file) {
    if (!file) return;
    uploadSelfie(file, function(err) {
      if (!err) selfieUploaded = true;
    });
  }

  function selectAnswer(qId, optIdx) {
    userAnswers[qId] = optIdx;
    renderStep(currentStep);
  }

  function nextQuestion() {
    var q = trainingQuestions[currentQuestionIdx];
    if (userAnswers[q.id] === undefined) {
      SafeHer.toast('Please select an answer to continue');
      return;
    }
    if (currentQuestionIdx < trainingQuestions.length - 1) {
      currentQuestionIdx++;
      renderStep(currentStep);
    }
  }

  function prevQuestion() {
    if (currentQuestionIdx > 0) {
      currentQuestionIdx--;
      renderStep(currentStep);
    }
  }

  function submitTrainingAnswers() {
    var q = trainingQuestions[currentQuestionIdx];
    if (userAnswers[q.id] === undefined) {
      SafeHer.toast('Please select an answer to finish');
      return;
    }

    submitTraining(function(err, res) {
      if (!err && res.ok && res.data.passed) {
        SafeHer.toast('Training passed with ' + res.data.score + '%!');
        applicationData.training_passed = true;
        applicationData.training_score = res.data.score;
        currentStep = 5;
        renderStep(currentStep);
      } else {
        var msg = (res && res.data && res.data.message) ? res.data.message : 'Training failed. Minimum 80% required. Try again after 24 hours.';
        SafeHer.toast(msg);
        renderStep(currentStep);
      }
    });
  }

  function submitFinal() {
    var declCheck = document.getElementById('wiz-decl-check');
    var sigInput = document.getElementById('wiz-signature');

    applicationData.declaration_accepted = declCheck ? declCheck.checked : false;
    applicationData.typed_signature = sigInput ? sigInput.value.trim() : '';

    if (!applicationData.declaration_accepted) {
      SafeHer.toast('You must accept the Code of Conduct declaration');
      return;
    }

    if (!applicationData.typed_signature) {
      SafeHer.toast('Please type your full name as signature');
      return;
    }

    if (applicationData.typed_signature.toLowerCase() !== applicationData.full_name.trim().toLowerCase()) {
      SafeHer.toast('Signature must exactly match your full name: "' + applicationData.full_name + '"');
      return;
    }

    saveDraft(function(err) {
      if (err) {
        SafeHer.toast(err);
        return;
      }
      submitApplication(function(subErr) {
        if (!subErr) {
          renderStep(currentStep);
        }
      });
    });
  }

  function fillDemoProfile() {
    SafeHer.toast('⚡ Pre-filling demo application...');
    var url = getBaseUrl() + '/api/volunteers/application/demo-fill';
    fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeader())
    })
      .then(function(res) { return res.json(); })
      .then(function(json) {
        applyDemoDataLocally();
      })
      .catch(function(err) {
        applyDemoDataLocally();
      });
  }

  function applyDemoDataLocally() {
    applicationData.full_name = 'Sunita Sharma';
    applicationData.dob = '1998-05-14';
    applicationData.locality = 'Whitefield, Bengaluru';
    applicationData.motivation = 'Dedicated to women safety, quick first-response, and local community assistance.';
    applicationData.availability_text = 'Evenings 6 PM - 11 PM and weekends';
    applicationData.id_type = 'Voter ID';
    applicationData.id_last4 = '8821';
    applicationData.references = [
      { name: 'Anand Rao', phone: '9845012345', relation: 'Colleague' },
      { name: 'Pooja Hegde', phone: '9845098765', relation: 'Mentor' }
    ];
    applicationData.training_passed = true;
    applicationData.training_score = 100.0;
    applicationData.declaration_accepted = true;
    applicationData.typed_signature = 'Sunita Sharma';
    applicationData.status = 'submitted';
    idUploaded = true;
    selfieUploaded = true;

    if (SafeHer.api && SafeHer.api.getVolunteerProfile) {
      var prof = SafeHer.api.getVolunteerProfile() || {};
      prof.name = 'Sunita Sharma';
      prof.status = 'submitted';
      prof.isAvailable = false;
      SafeHer.api.setVolunteerProfile(prof);
    }
    renderStep(1);
    SafeHer.toast('Demo application submitted! Open admin.html to approve.');
  }

  function checkApprovalStatus() {
    loadApplication(function(err, app) {
      if (!err && app) {
        if (app.status === 'approved') {
          SafeHer.toast('Congratulations! Your volunteer profile is Approved.');
          if (SafeHer.volunteer && SafeHer.volunteer.render) SafeHer.volunteer.render();
          initOrRender();
        } else {
          SafeHer.toast('Status is currently: ' + app.status + '. Awaiting approval in Admin Portal.');
          renderStep(currentStep);
        }
      }
    });
  }

  function startWizard(step) {
    currentStep = step || 1;
    applicationData.status = 'draft';
    renderStep(currentStep);
  }

  // ─── PUBLIC INITIALIZATION ────────────────────────────────
  function initOrRender() {
    loadApplication(function(err, app) {
      var container = document.getElementById('volunteer-app-container');
      var statusCard = document.querySelector('.volunteer-status-card');
      var alertCard = document.getElementById('volunteer-alert-card');

      if (app && app.status === 'approved') {
        if (statusCard) statusCard.style.display = 'block';
        if (container) container.innerHTML = '';
      } else {
        // Hide active responder toggles when not yet approved
        if (statusCard) statusCard.style.display = 'none';
        if (alertCard) alertCard.style.display = 'none';
        renderStep(currentStep);
      }
    });
  }

  return {
    initOrRender: initOrRender,
    goNext: goNext,
    goBack: goBack,
    handleIdFile: handleIdFile,
    handleSelfieFile: handleSelfieFile,
    selectAnswer: selectAnswer,
    nextQuestion: nextQuestion,
    prevQuestion: prevQuestion,
    submitTrainingAnswers: submitTrainingAnswers,
    submitFinal: submitFinal,
    startWizard: startWizard,
    fillDemoProfile: fillDemoProfile,
    checkApprovalStatus: checkApprovalStatus
  };
})();
