// Wait for the session check before rendering the form.
(async function () {

// Use the server session instead of per-tab browser storage.
const session = await NSPA.requireSession();
const signedInMember = session.member;

const phoneInputField = document.querySelector('#phone');

const phoneInput = window.intlTelInput(phoneInputField, {
  initialCountry: 'ca',
  allowDropdown: true,
  separateDialCode: true,
  nationalMode: true,
  autoHideDialCode: false,
  autoPlaceholder: 'polite',
  countrySearch: false,
  utilsScript: 'https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js',
});

phoneInputField.setAttribute('autocomplete', 'off');

prefillMemberContact(signedInMember);

const legacySignoutBtn = document.getElementById('signoutBtn');
if (legacySignoutBtn) {
  legacySignoutBtn.addEventListener('click', () => NSPA.signOut());
}

function prefillMemberContact(member) {
  document.getElementById('prospector_first_name').value = member.firstName || '';
  document.getElementById('prospector_last_name').value = member.lastName || '';
  document.getElementById('contact-email').value = member.email || '';
  document.getElementById('memberIdPill').textContent = member.memberId ? `Member ID ${member.memberId}` : '';
  if (member.phone) phoneInput.setNumber(member.phone);
}

// Lock the selected country so typing/pasting a number never auto-switches it.
// Manual selection from the flag dropdown still works.
let lockedCountry = (phoneInput.getSelectedCountryData().iso2 || 'ca');
let manualCountryPick = false;

const itiContainer = phoneInputField.closest('.iti');
if (itiContainer) {
  // mousedown fires (in the capture phase) before the library's click handler
  // updates the country, so when `countrychange` runs we know it was deliberate.
  itiContainer.addEventListener('mousedown', e => {
    if (e.target.closest('.iti__country')) manualCountryPick = true;
  }, true);
}

phoneInputField.addEventListener('countrychange', () => {
  const current = phoneInput.getSelectedCountryData().iso2;
  if (manualCountryPick) {
    lockedCountry = current;          // user chose it from the dropdown — keep it
    manualCountryPick = false;
  } else if (current && current !== lockedCountry) {
    phoneInput.setCountry(lockedCountry); // auto-switch from typing — undo it
  }
});


let tenureEntryCounter = 0;
const tenureEntries = []; 

class TenureEntry {
  constructor(container) {
    this.id = ++tenureEntryCounter;
    this.map = null;
    this.tenureLayer = null;
    this.fetchedGeoJSON = null;
    this.confirmed = false;
    this.confirmedNumber = '';

    this.el = this._buildDOM();
    container.appendChild(this.el);
    this._bindEvents();
  }

  _buildDOM() {
    const entry = document.createElement('div');
    entry.className = 'tenure-entry';
    entry.dataset.entryId = this.id;

    entry.innerHTML = `
      <div class="tenure-entry-header">
        <span class="tenure-entry-label">Tenure #${this.id}</span>
        <button type="button" class="tenure-remove-btn" aria-label="Remove tenure">
          <svg viewBox="0 0 14 14" width="13" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          </svg>
        </button>
      </div>

      <div class="tenure-input-row">
        <input
          type="text"
          class="tenure-number-input"
          placeholder="e.g. NS-2024-12345"
          aria-label="Tenure number ${this.id}"
          autocomplete="off"
          spellcheck="false"
        />
        <button type="button" class="secondary-btn tenure-lookup-btn">Look Up</button>
        <span class="tenure-lookup-status" role="status" aria-live="polite"></span>
      </div>

      <div class="tenure-confirm-section" style="display:none;">
        <div class="tenure-map" role="application" aria-label="Tenure location map"></div>
        <textarea class="geojson-output" readonly aria-label="Tenure details"
                  placeholder="Tenure details will appear here…"></textarea>
        <div style="display:flex; justify-content:flex-end; margin-top:12px;">
          <button type="button" class="secondary-btn tenure-confirm-btn">Confirm Location</button>
        </div>
      </div>
    `;

    return entry;
  }

  _bindEvents() {
    this.numberInput    = this.el.querySelector('.tenure-number-input');
    this.lookupBtn      = this.el.querySelector('.tenure-lookup-btn');
    this.statusEl       = this.el.querySelector('.tenure-lookup-status');
    this.confirmSection = this.el.querySelector('.tenure-confirm-section');
    this.mapEl          = this.el.querySelector('.tenure-map');
    this.geojsonOutput  = this.el.querySelector('.geojson-output');
    this.confirmBtn     = this.el.querySelector('.tenure-confirm-btn');
    this.removeBtn      = this.el.querySelector('.tenure-remove-btn');

    this.numberInput.addEventListener('input', () => this._onNumberChange());
    this.lookupBtn.addEventListener('click', () => this.lookup());
    this.confirmBtn.addEventListener('click', () => this._confirm());
    this.removeBtn.addEventListener('click', () => this._remove());
  }

  _onNumberChange() {
    const current = normalizeTenureNumber(this.numberInput.value);
    if (this.confirmedNumber && current !== this.confirmedNumber) {
      this._resetConfirmation();
    }
  }

  _resetConfirmation() {
    this.confirmed = false;
    this.confirmedNumber = '';
    this.fetchedGeoJSON = null;

    this.confirmBtn.classList.remove('confirmed');
    this.confirmBtn.textContent = 'Confirm Location';
    this.geojsonOutput.value = '';

    if (this.tenureLayer && this.map) {
      this.map.removeLayer(this.tenureLayer);
      this.tenureLayer = null;
    }

    this.confirmSection.style.display = 'none';
  }

  async lookup() {
    const tenureNumber = normalizeTenureNumber(this.numberInput.value);

    if (!tenureNumber) {
      showToast('Please enter a tenure number.', 'error');
      this.numberInput.focus();
      return;
    }

    this.statusEl.textContent = 'Looking up tenure…';
    this.lookupBtn.disabled = true;

    try {
      this.fetchedGeoJSON = await fetchTenureGeometry(tenureNumber);
      this.confirmed = false;
      this.confirmedNumber = '';

      this.confirmBtn.classList.remove('confirmed');
      this.confirmBtn.textContent = 'Confirm Location';

      this._showMap();

      const count = this.fetchedGeoJSON.features?.length || 0;
      this.statusEl.textContent = `${count} polygon${count === 1 ? '' : 's'} found.`;
      showToast('Tenure loaded — please confirm on the map.', 'success');
    } catch (error) {
      this.statusEl.textContent = '';
      this._resetConfirmation();
      showToast(error.message || 'Could not find that tenure number.', 'error');
    } finally {
      this.lookupBtn.disabled = false;
    }
  }

  _showMap() {
    this.confirmSection.style.display = 'block';

    if (!this.map) {
      this.map = L.map(this.mapEl).setView([45.1, -63.0], 7);

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        maxZoom: 19
      }).addTo(this.map);
    }

    if (this.tenureLayer) {
      this.map.removeLayer(this.tenureLayer);
    }

    this.tenureLayer = L.geoJSON(this.fetchedGeoJSON, {
      style: {
        color: '#C9A84C',
        weight: 3,
        fillColor: '#E8C97A',
        fillOpacity: 0.28
      },
      onEachFeature(feature, layer) {
        const props = feature.properties || {};
        const claimId = props.claim_id || props.CLAIM_ID || 'Claim';
        layer.bindPopup(`<strong>${claimId}</strong>`);
      }
    }).addTo(this.map);

    this.map.fitBounds(this.tenureLayer.getBounds(), { padding: [30, 30] });
    this.geojsonOutput.value = formatTenureDetails(this.fetchedGeoJSON);

    setTimeout(() => {
      this.map.invalidateSize();
    }, 150);

    this.confirmSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  _confirm() {
    const tenureNumber = normalizeTenureNumber(this.numberInput.value);

    if (!this.fetchedGeoJSON) {
      showToast('Look up the tenure location first.', 'error');
      return;
    }

    this.confirmed = true;
    this.confirmedNumber = tenureNumber;

    this.confirmBtn.classList.add('confirmed');
    this.confirmBtn.textContent = 'Location Confirmed ✓';

    showToast('Location confirmed.', 'success');
  }

  _remove() {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }

    this.el.remove();

    const idx = tenureEntries.indexOf(this);
    if (idx !== -1) tenureEntries.splice(idx, 1);

    if (tenureEntries.length === 0) {
      addTenureEntry(); // also renumbers
    } else {
      renumberTenures();
    }
  }

  get tenureNumber() {
    return normalizeTenureNumber(this.numberInput.value);
  }

  get geojson() {
    return this.fetchedGeoJSON;
  }

  get isConfirmed() {
    return this.confirmed;
  }
}

function renumberTenures() {
  tenureEntries.forEach((entry, i) => {
    entry.el.querySelector('.tenure-entry-label').textContent = `Tenure #${i + 1}`;
  });
}

function addTenureEntry() {
  const container = document.getElementById('tenure-entries-container');
  const entry = new TenureEntry(container);
  tenureEntries.push(entry);
  renumberTenures();
  return entry;
}

document.getElementById('add-tenure-btn').addEventListener('click', () => {
  addTenureEntry();
});

addTenureEntry();

function normalizeTenureNumber(value) {
  return String(value || '').trim().toUpperCase();
}

/* ── Additional documents ─────────────────────────────────────────────── */

const DOC_ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.jpg', '.jpeg', '.png'];
const DOC_MAX_SIZE = 100 * 1024 * 1024; // 100 MB per file
const DOC_MAX_COUNT = 10;

let documentEntryCounter = 0;
const documentEntries = [];

function validateDocumentFile(file) {
  const dot = file.name.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.name.slice(dot).toLowerCase();
  if (!DOC_ALLOWED_EXTENSIONS.includes(ext)) {
    return `"${file.name}" is not an accepted file type. Accepted formats: PDF, DOC, DOCX, XLS, XLSX, CSV, JPG, PNG.`;
  }
  if (file.size > DOC_MAX_SIZE) {
    return `"${file.name}" is ${formatFileSize(file.size)} — documents must be 100 MB or smaller.`;
  }
  if (file.size === 0) {
    return `"${file.name}" is empty.`;
  }
  return null;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

class DocumentEntry {
  constructor(container) {
    this.id = ++documentEntryCounter;
    this.file = null;

    this.el = this._buildDOM();
    container.appendChild(this.el);
    this._bindEvents();
  }

  _buildDOM() {
    const entry = document.createElement('div');
    entry.className = 'doc-entry';
    entry.dataset.entryId = this.id;

    entry.innerHTML = `
      <div class="tenure-entry-header">
        <span class="tenure-entry-label doc-entry-label">Document #${this.id}</span>
        <button type="button" class="tenure-remove-btn doc-remove-btn" aria-label="Remove document">
          <svg viewBox="0 0 14 14" width="13" height="13" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          </svg>
        </button>
      </div>

      <div class="doc-file-row">
        <input type="file" class="doc-file-input" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.jpg,.jpeg,.png"
               aria-label="Choose file for document ${this.id}" hidden />
        <button type="button" class="secondary-btn doc-choose-btn">
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7 9V1.8M4 4.5L7 1.5l3 3M2 9.5V11a1.5 1.5 0 001.5 1.5h7A1.5 1.5 0 0012 11V9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Choose File
        </button>
        <span class="doc-file-name">No file selected</span>
      </div>

      <input type="text" class="doc-title-input" maxlength="200"
             aria-label="Title or description for document ${this.id}"
             placeholder="Document title or description (optional)" />
      <p class="doc-error" role="alert" hidden></p>
    `;

    return entry;
  }

  _bindEvents() {
    this.fileInput  = this.el.querySelector('.doc-file-input');
    this.chooseBtn  = this.el.querySelector('.doc-choose-btn');
    this.fileNameEl = this.el.querySelector('.doc-file-name');
    this.titleInput = this.el.querySelector('.doc-title-input');
    this.errorEl    = this.el.querySelector('.doc-error');
    this.removeBtn  = this.el.querySelector('.doc-remove-btn');

    this.chooseBtn.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => this._onFileChange());
    this.removeBtn.addEventListener('click', () => this._remove());
  }

  _onFileChange() {
    this.clearError();
    const file = this.fileInput.files[0] || null;

    if (!file) {
      this.file = null;
      this.fileNameEl.textContent = 'No file selected';
      this.el.classList.remove('has-file');
      return;
    }

    const error = validateDocumentFile(file);
    if (error) {
      this.fileInput.value = '';
      this.file = null;
      this.fileNameEl.textContent = 'No file selected';
      this.el.classList.remove('has-file');
      this.showError(error);
      showToast(error, 'error');
      return;
    }

    this.file = file;
    this.fileNameEl.textContent = `${file.name} (${formatFileSize(file.size)})`;
    this.el.classList.add('has-file');
  }

  showError(message) {
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
    this.el.classList.add('has-error');
  }

  clearError() {
    this.errorEl.hidden = true;
    this.el.classList.remove('has-error');
  }

  get title() {
    return this.titleInput.value.trim();
  }

  _remove() {
    this.el.remove();

    const idx = documentEntries.indexOf(this);
    if (idx !== -1) documentEntries.splice(idx, 1);

    if (documentEntries.length === 0) {
      addDocumentEntry(); // also renumbers
    } else {
      renumberDocuments();
    }
  }
}

function renumberDocuments() {
  documentEntries.forEach((entry, i) => {
    entry.el.querySelector('.doc-entry-label').textContent = `Document #${i + 1}`;
  });
}

function addDocumentEntry() {
  const container = document.getElementById('document-entries-container');
  const entry = new DocumentEntry(container);
  documentEntries.push(entry);
  renumberDocuments();
  return entry;
}

document.getElementById('add-document-btn').addEventListener('click', () => {
  if (documentEntries.length >= DOC_MAX_COUNT) {
    showToast(`You can attach at most ${DOC_MAX_COUNT} documents.`, 'error');
    return;
  }
  addDocumentEntry();
});

addDocumentEntry();

function resetDocumentEntries() {
  documentEntries.splice(0).forEach(entry => entry.el.remove());
  addDocumentEntry();
}

async function fetchTenureGeometry(tenureNumber) {
  const response = await fetch(`/api/tenure/${encodeURIComponent(tenureNumber)}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Tenure not found');
  }

  return await response.json();
}

function formatTenureDetails(geojson) {
  const feature = geojson.features?.[0];
  if (!feature) return 'No tenure details found.';

  const p = feature.properties || {};
  const s = p.claimSummary || {};
  const loc = p.parsedLocation;

  return [
    `Right Number: ${s.rightNumber || p.TENURE_NUMBER_ID || 'N/A'}`,
    `Title Type: ${s.titleType || p.MTA_TITLE_TYPE_CODE || 'N/A'}`,
    `Tenure Type: ${s.tenureType || p.MTA_TENURE_TYPE_CODE || 'N/A'}`,
    `Issue Date: ${formatArcGISDate(s.issueDate || p.ISSUE_DATE)}`,
    `Anniversary Date: ${formatArcGISDate(s.anniversaryDate || p.GOOD_TO_DATE)}`,
    `Expiry Date: ${formatArcGISDate(s.expiryDate || p.EXPIRY_DATE)}`,
    `Area: ${s.areaHa || p.AREA_IN_HECTARES || 'N/A'} ha`,
    `Status: ${s.status || p.MINERAL_TENURE_STATUS_CODE || 'N/A'}`,
    `ESRI OID: ${s.objectId || p.OBJECTID || 'N/A'}`,
    `Location: ${p.location || 'N/A'}`,
    `Claims: ${loc?.claimIds?.join(', ') || 'N/A'}`,
    `Map: ${loc?.map || 'N/A'}`,
    `Tract: ${loc?.tract || 'N/A'}`,
    `Claim Letters: ${loc?.letters?.join(', ') || 'N/A'}`
  ].join('\n');
}

function formatArcGISDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

const depositDropdown = document.getElementById('depositDropdown');
const depositTrigger = document.getElementById('depositTrigger');
const depositPanel = document.getElementById('depositPanel');
const depositInput = document.getElementById('deposit-type-select');
const depositTriggerText = depositTrigger.querySelector('.deposit-trigger-text');
const depositSearch = document.getElementById('depositSearch');
const depositEmpty = document.getElementById('depositEmpty');
const depositUndeterminedContainer = document.getElementById('depositUndeterminedContainer');
let depositUndeterminedEl = null;

depositTrigger.addEventListener('click', () => {
  depositDropdown.classList.toggle('open');
  if (depositDropdown.classList.contains('open')) {
    setTimeout(() => depositSearch.focus(), 0);
  }
});

depositSearch.addEventListener('input', () => {
  const query = depositSearch.value.trim().toLowerCase();
  let currentLabel = null;
  let groupHasMatch = false;

  const finalizeGroup = () => {
    if (currentLabel) currentLabel.style.display = groupHasMatch ? '' : 'none';
  };

  [...depositPanel.children].forEach(child => {
    if (child === depositSearch) return;

    if (child.classList.contains('deposit-group-label')) {
      finalizeGroup();
      currentLabel = child;
      groupHasMatch = false;
    } else if (child.classList.contains('deposit-card')) {
      const name = child.querySelector('.deposit-name').textContent.toLowerCase();
      const match = name.includes(query);
      child.style.display = match ? '' : 'none';
      if (match) groupHasMatch = true;
    }
  });

  finalizeGroup();
});

document.addEventListener('click', e => {
  if (!depositDropdown.contains(e.target)) {
    depositDropdown.classList.remove('open');
  }
});

// Deposit type is multi-select. The standalone "undetermined" option is
// mutually exclusive with specific deposit types.
function getSelectedDepositTypes() {
  if (depositUndeterminedEl && depositUndeterminedEl.classList.contains('selected')) {
    return [{
      value: depositUndeterminedEl.dataset.value,
      label: depositUndeterminedEl.querySelector('.deposit-undetermined-label').textContent
    }];
  }
  return [...depositPanel.querySelectorAll('.deposit-card.selected')].map(c => ({
    value: c.dataset.value,
    label: c.querySelector('.deposit-name').textContent
  }));
}

function updateDepositTrigger() {
  const selected = getSelectedDepositTypes();
  depositInput.value = selected.map(s => s.value).join(',');
  depositDropdown.classList.toggle('has-selection', selected.length > 0);
  depositTriggerText.textContent =
    selected.length === 0
      ? 'Select deposit type'
      : selected.length === 1
        ? selected[0].label
        : `${selected.length} deposit types selected`;
}

// Build the grouped deposit dropdown from the sheet data. A parent category
// with no subtypes is rendered separately as a standalone "undetermined" option.
function buildDepositTypes(data) {
  [...depositPanel.children].forEach(child => {
    if (child !== depositSearch) child.remove();
  });

  const groups = data.groups || [];

  if (groups.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'deposit-empty';
    msg.textContent = 'No deposit types found.';
    depositPanel.appendChild(msg);
  }

  groups.forEach(group => {
    const label = document.createElement('p');
    label.className = 'deposit-group-label';
    label.textContent = group.parent;
    depositPanel.appendChild(label);

    group.subtypes.forEach(sub => {
      const card = document.createElement('div');
      card.className = 'deposit-card';
      card.dataset.value = sub.value;

      const name = document.createElement('span');
      name.className = 'deposit-name';
      name.textContent = sub.label;
      card.appendChild(name);

      card.addEventListener('click', () => {
        card.classList.toggle('selected');
        // Picking a specific type clears the "undetermined" choice.
        if (card.classList.contains('selected') && depositUndeterminedEl) {
          depositUndeterminedEl.classList.remove('selected');
        }
        updateDepositTrigger();
      });

      depositPanel.appendChild(card);
    });
  });

  // Standalone option — clicking it sets the deposit type to "undetermined"
  // and clears any specific selections.
  depositUndeterminedContainer.innerHTML = '';
  depositUndeterminedEl = null;

  if (data.undetermined) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'deposit-undetermined';
    opt.dataset.value = data.undetermined.value;
    opt.innerHTML = '<span class="deposit-undetermined-box"></span><span class="deposit-undetermined-label"></span>';
    opt.querySelector('.deposit-undetermined-label').textContent = data.undetermined.label;

    opt.addEventListener('click', () => {
      const willSelect = !opt.classList.contains('selected');
      if (willSelect) {
        depositPanel.querySelectorAll('.deposit-card.selected')
          .forEach(c => c.classList.remove('selected'));
      }
      opt.classList.toggle('selected', willSelect);
      updateDepositTrigger();
    });

    depositUndeterminedContainer.appendChild(opt);
    depositUndeterminedEl = opt;
  }
}

const stageCards = document.querySelectorAll('.stage-card');
const stageInput = document.getElementById('project-stage-select');

stageCards.forEach(card => {
  card.addEventListener('click', () => {
    stageCards.forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    stageInput.value = card.dataset.value;
  });
});

const commodityBtn = document.getElementById('commodityBtn');
const commodityList = document.getElementById('commodityList');
const commodityBtnText = commodityBtn.querySelector('.commodity-btn-text');
const commoditySearch = document.getElementById('commoditySearch');
const commodityEmpty = document.getElementById('commodityEmpty');

commodityBtn.addEventListener('click', () => {
  commodityBtn.classList.toggle('open');
  if (commodityBtn.classList.contains('open')) {
    setTimeout(() => commoditySearch.focus(), 0);
  }
});

commoditySearch.addEventListener('input', () => {
  const query = commoditySearch.value.trim().toLowerCase();
  commodityList.querySelectorAll('.commodity-item').forEach(item => {
    const match = item.dataset.value.toLowerCase().includes(query);
    item.style.display = match ? '' : 'none';
  });
});

document.addEventListener('click', e => {
  if (!commodityBtn.contains(e.target) && !commodityList.contains(e.target)) {
    commodityBtn.classList.remove('open');
  }
});

function updateCommodityButton() {
  const checked = commodityList.querySelectorAll('.commodity-item.checked');
  commodityBtn.classList.toggle('has-selection', checked.length > 0);
  commodityBtnText.textContent =
    checked.length > 0
      ? checked.length === 1
        ? checked[0].dataset.value
        : `${checked.length} commodities selected`
      : 'Select all that apply';
}

// Build the commodity checklist from the sheet data.
function buildCommodities(list) {
  commodityList.querySelectorAll('.commodity-item, .commodity-empty').forEach(el => el.remove());

  if (!list || list.length === 0) {
    const li = document.createElement('li');
    li.className = 'commodity-empty';
    li.textContent = 'No commodities found.';
    commodityList.appendChild(li);
    return;
  }

  list.forEach(value => {
    const li = document.createElement('li');
    li.className = 'commodity-item';
    li.dataset.value = value;

    const check = document.createElement('span');
    check.className = 'commodity-check';
    check.textContent = '✓';

    li.appendChild(check);
    li.appendChild(document.createTextNode(value));

    li.addEventListener('click', () => {
      li.classList.toggle('checked');
      updateCommodityButton();
    });

    commodityList.appendChild(li);
  });
}

// Pull the commodity + deposit-type options from the Google Sheet on load.
async function loadFormOptions() {
  try {
    const res = await fetch('/api/commodities');
    if (!res.ok) throw new Error('Failed to load commodities');
    buildCommodities(await res.json());
  } catch (err) {
    console.error(err);
    if (commodityEmpty) commodityEmpty.textContent = 'Could not load commodities.';
  }

  try {
    const res = await fetch('/api/deposit-types');
    if (!res.ok) throw new Error('Failed to load deposit types');
    buildDepositTypes(await res.json());
  } catch (err) {
    console.error(err);
    if (depositEmpty) depositEmpty.textContent = 'Could not load deposit types.';
  }
}

loadFormOptions();

const showToast = NSPA.showToast;

document.getElementById('submit-btn').addEventListener('click', async () => {
  const firstName = document.getElementById('prospector_first_name').value.trim();
  const lastName  = document.getElementById('prospector_last_name').value.trim();

  if (!firstName || !lastName) {
    showToast('Please enter your first and last name.', 'error');
    document.getElementById('prospector_first_name').focus();
    return;
  }

  const email = document.getElementById('contact-email').value.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Please enter a valid email address.', 'error');
    return;
  }

  const phoneNumber = phoneInput.getNumber();
  if (phoneInputField.value.trim() && !phoneInput.isValidNumber()) {
    showToast('Please enter a valid phone number.', 'error');
    phoneInputField.focus();
    return;
  }

  const filledEntries = tenureEntries.filter(e => e.tenureNumber);

  if (filledEntries.length === 0) {
    showToast('Please enter at least one tenure number.', 'error');
    tenureEntries[0]?.numberInput.focus();
    return;
  }

  for (const entry of filledEntries) {
    if (!entry.geojson || entry.confirmedNumber !== entry.tenureNumber) {
      await entry.lookup();
      return; 
    }
  }

  const unconfirmed = filledEntries.filter(e => !e.isConfirmed);
  if (unconfirmed.length > 0) {
    unconfirmed[0]._showMap();
    showToast(
      `Please confirm the location for tenure ${unconfirmed[0].tenureNumber}.`,
      'error'
    );
    return;
  }

  // Re-validate the attached documents just before submission.
  const filledDocuments = documentEntries.filter(e => e.file);
  for (const entry of filledDocuments) {
    const error = validateDocumentFile(entry.file);
    if (error) {
      entry.showError(error);
      entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showToast(error, 'error');
      return;
    }
  }
  if (filledDocuments.length > DOC_MAX_COUNT) {
    showToast(`You can attach at most ${DOC_MAX_COUNT} documents.`, 'error');
    return;
  }

  const selectedCommodities = [...commodityList.querySelectorAll('.commodity-item.checked')]
    .map(el => el.dataset.value);

  const submission = {
    memberId: signedInMember.memberId || '',
    firstName,
    lastName,
    email,
    phone: phoneNumber,
    project:         document.getElementById('project').value.trim(),
    operator:        document.getElementById('operator').value.trim(),
    description:     document.getElementById('project-description').value.trim(),
    tenures: filledEntries.map(e => ({
      tenureNumber: e.tenureNumber,
      geojson:      e.geojson,
    })),
    commodities:     selectedCommodities,
    depositTypes:    getSelectedDepositTypes().map(s => s.value),
    projectStage:    document.getElementById('project-stage-select').value,
    resourceEstimate: document.getElementById('resource-estimate-id').value.trim(),
    resourceSource:  document.getElementById('resource-estimate-source').value.trim(),
    website:         document.getElementById('website-link').value.trim(),
  };

  console.log('Submission:', submission);

  try {
    // Documents ride along as multipart/form-data; a plain JSON body is kept
    // for submissions with no attachments.
    let fetchOptions;
    if (filledDocuments.length > 0) {
      const formData = new FormData();
      formData.append('payload', JSON.stringify(submission));
      formData.append('documentTitles', JSON.stringify(filledDocuments.map(e => e.title)));
      filledDocuments.forEach(e => formData.append('documents', e.file, e.file.name));
      fetchOptions = { method: 'POST', body: formData };
    } else {
      fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      };
    }

    const response = await fetch('/api/projects', fetchOptions);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Submission failed');
    }

    resetDocumentEntries();
    showToast(`Project submitted — thank you, ${firstName}!`, 'success');
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Location confirmed, but project save failed. Check server logs.', 'error');
  }
});

const metalPricesToggle = document.getElementById('metalPricesToggle');
const metalPricesPanel = document.getElementById('metalPricesPanel');
const pricesGrid = document.getElementById('pricesGrid');
const pricesUpdatedEl = document.getElementById('pricesUpdated');
let metalPricesLoaded = false;

if (metalPricesToggle && metalPricesPanel) {
  metalPricesToggle.addEventListener('click', async () => {
    const willOpen = !metalPricesPanel.classList.contains('open');
    metalPricesPanel.classList.toggle('open', willOpen);
    metalPricesToggle.classList.toggle('active', willOpen);
    if (willOpen && !metalPricesLoaded) {
      await loadMetalPrices();
    }
  });
}

function fmtPrice(value, currency) {
  const digits = Math.abs(value) < 10 ? 4 : 2;
  const num = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
  return `${currency === 'USD' ? '$' : ''}${num}${currency !== 'USD' ? ' ' + currency : ''}`;
}

function priceChangeBadge(m) {
  if (!m.ok || typeof m.change !== 'number') return ''; // no change data on the free plan
  const dir = m.change > 0.0001 ? 'up' : m.change < -0.0001 ? 'down' : 'flat';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '◆';
  const pct = Math.abs(m.changePct).toFixed(2);
  return `<span class="price-change ${dir}">${arrow} ${pct}%</span>`;
}

function renderPriceCard(m) {
  if (!m.ok) {
    return `
      <div class="price-card unavailable">
        <div class="price-card-head">
          <span class="price-name">${m.name}</span>
          <span class="price-symbol">${m.symbol}</span>
        </div>
        <div class="price-value">Unavailable</div>
        <div class="price-meta"><span class="price-unit">${m.unit}</span>${priceChangeBadge(m)}</div>
      </div>`;
  }

  return `
    <div class="price-card">
      <div class="price-card-head">
        <span class="price-name">${m.name}</span>
        <span class="price-symbol">${m.symbol}</span>
      </div>
      <div class="price-value">${fmtPrice(m.price, m.currency)}</div>
      <div class="price-meta"><span class="price-unit">${m.unit}</span>${priceChangeBadge(m)}</div>
    </div>`;
}

async function loadMetalPrices() {
  pricesUpdatedEl.textContent = 'Refreshing…';
  try {
    const res = await fetch('/api/metal-prices');
    if (!res.ok) throw new Error('request failed');
    const data = await res.json();

    pricesGrid.innerHTML = data.metals.map(renderPriceCard).join('');
    const t = new Date(data.updatedAt);
    pricesUpdatedEl.textContent = 'Updated ' + t.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' });
    metalPricesLoaded = true;
  } catch (err) {
    pricesUpdatedEl.textContent = 'Could not load prices';
    pricesGrid.innerHTML = '<p class="prices-disclaimer">Unable to reach the price service right now.</p>';
  }
}

})();
