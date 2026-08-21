'use strict';

/* events */
if (location.pathname === '/events.html') {
  (() => {
    const { esc, api, showToast, fmtDateTime, fmtSize } = NSPA;
        const upcomingBody = document.getElementById('upcomingBody');
        const pastBody = document.getElementById('pastBody');
        const pastCard = document.getElementById('pastCard');
        const adminCard = document.getElementById('adminCard');
    
        const CATEGORY_LABELS = {
          conference: 'Conference',
          workshop: 'Workshop',
          field_trip: 'Field Trip',
          meeting: 'Member Meeting',
        };
    
        let allEvents = [];      // upcoming, already chronological from the server
        let pastEvents = [];     // only present when the archive is enabled (or admin)
        let archiveEnabled = false;
        let isAdmin = false;
        let activeCategory = '';
    
        function capacityLabel(e) {
          return e.capacity == null ? 'No listed limit' : `${e.capacity} seat${e.capacity === 1 ? '' : 's'}`;
        }
    
        function eventFiles(e) {
          const files = e.files || [];
          if (!files.length) return '';
          const images = files.filter(f => String(f.mimeType || '').startsWith('image/'));
          const docs = files.filter(f => !String(f.mimeType || '').startsWith('image/'));
          return `
            <div class="event-files">
              ${images.length ? `<div class="event-image-grid">${images.map(f => `
                <a href="/api/events/${encodeURIComponent(e.id)}/files/${encodeURIComponent(f.id)}/download" download>
                  <img src="/api/events/${encodeURIComponent(e.id)}/files/${encodeURIComponent(f.id)}/view" alt="${esc(f.fileName)}" loading="lazy" />
                </a>
              `).join('')}</div>` : ''}
              ${docs.length ? `<div class="event-file-list">${docs.map(f => `
                <a class="event-file-link" href="/api/events/${encodeURIComponent(e.id)}/files/${encodeURIComponent(f.id)}/download" download>
                  <span>${esc(f.fileName)}</span>
                  <small>${esc(fmtSize(f.size))}</small>
                </a>
              `).join('')}</div>` : ''}
            </div>`;
        }
    
        function card(e, isPast) {
          const when = e.endsAt
            ? `${fmtDateTime(e.startsAt)} – ${fmtDateTime(e.endsAt)}`
            : fmtDateTime(e.startsAt);
          const adminBtn = isAdmin
            ? `<button type="button" class="text-danger-btn event-delete-btn" data-id="${esc(e.id)}"
                       aria-label="Delete event ${esc(e.title)}">Delete</button>`
            : '';
          return `
            <article class="event-card">
              <div class="event-card-head">
                <div>
                  <span class="event-category event-${esc(e.category)}">${esc(CATEGORY_LABELS[e.category] || e.category)}</span>
                  <h2 class="event-title">${esc(e.title)}</h2>
                </div>
              </div>
              <dl class="event-facts">
                <div><dt>When</dt><dd><time datetime="${esc(e.startsAt)}">${esc(when)}</time></dd></div>
                ${e.location ? `<div><dt>Where</dt><dd>${esc(e.location)}</dd></div>` : ''}
                <div><dt>Capacity</dt><dd>${esc(capacityLabel(e))}</dd></div>
              </dl>
              ${e.description ? `<p class="event-description">${esc(e.description)}</p>` : ''}
              ${eventFiles(e)}
              <div class="event-actions">
                ${adminBtn}
              </div>
            </article>`;
        }
    
        function render() {
          // The server already decides what's upcoming vs past and whether the
          // archive is visible to this viewer — the page only filters by category.
          const upcoming = allEvents.filter(e => !activeCategory || e.category === activeCategory);
          const past = pastEvents.filter(e => !activeCategory || e.category === activeCategory);
    
          upcomingBody.innerHTML = upcoming.length
            ? `<div class="event-grid">${upcoming.map(e => card(e, false)).join('')}</div>`
            : '<p class="membership-lead">No upcoming events in this category.</p>';
    
          const archiveNote = isAdmin
            ? `<label class="map-toggle archive-toggle">
                 <input type="checkbox" id="archiveToggle"${archiveEnabled ? ' checked' : ''} />
                 <span>Archive visible to members</span>
               </label>`
            : '';
          pastCard.hidden = past.length === 0 && !isAdmin;
          pastBody.innerHTML = `
            ${archiveNote}
            ${past.length
              ? `<div class="event-grid">${past.map(e => card(e, true)).join('')}</div>`
              : (isAdmin ? '<p class="form-hint">No past events yet.</p>' : '')}`;
    
          const toggle = document.getElementById('archiveToggle');
          if (toggle) toggle.addEventListener('change', setArchive);
    
          document.querySelectorAll('.event-delete-btn').forEach(b =>
            b.addEventListener('click', () => removeEvent(b))
          );
        }
    
        async function removeEvent(btn) {
          if (!confirm('Delete this event? Registrations will be removed too.')) return;
          btn.disabled = true;
          try {
            await api(`/api/admin/events/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
            showToast('Event deleted.', 'success');
            await load();
          } catch (e) {
            btn.disabled = false;
            showToast(e.message, 'error');
          }
        }
    
        document.getElementById('categoryFilter').addEventListener('click', e => {
          const chip = e.target.closest('.filter-chip');
          if (!chip) return;
          document.querySelectorAll('#categoryFilter .filter-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          activeCategory = chip.dataset.category;
          render();
        });
    
        document.getElementById('eventForm').addEventListener('submit', async ev => {
          ev.preventDefault();
          const btn = document.getElementById('createEventBtn');
          const start = document.getElementById('ev-start').value;
          const title = document.getElementById('ev-title').value.trim();
    
          if (!title) return showToast('An event title is required.', 'error');
          if (!start) return showToast('A start date and time is required.', 'error');
    
          btn.disabled = true;
          try {
            const formData = new FormData();
            formData.append('title', title);
            formData.append('category', document.getElementById('ev-category').value);
            formData.append('startsAt', start);
            formData.append('endsAt', document.getElementById('ev-end').value || '');
            formData.append('location', document.getElementById('ev-location').value.trim());
            formData.append('capacity', document.getElementById('ev-capacity').value);
            formData.append('description', document.getElementById('ev-description').value.trim());
            for (const file of document.getElementById('ev-files').files) formData.append('files', file);
    
            await api('/api/admin/events', {
              method: 'POST',
              body: formData,
            });
            ev.target.reset();
            showToast('Event created.', 'success');
            await load();
          } catch (e) {
            showToast(e.message, 'error');
          } finally {
            btn.disabled = false;
          }
        });
    
        async function setArchive(e) {
          const enabled = e.target.checked;
          e.target.disabled = true;
          try {
            await api('/api/admin/events-archive', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled }),
            });
            archiveEnabled = enabled;
            showToast(enabled ? 'Past events are now visible to members.' : 'Past events are now hidden from members.', 'success');
          } catch (err) {
            e.target.checked = !enabled;
            showToast(err.message, 'error');
          } finally {
            e.target.disabled = false;
          }
        }
    
        async function load() {
          try {
            const [data, me] = await Promise.all([
              api('/api/events'),
              NSPA.getSession(),
            ]);
            allEvents = data.events;
            pastEvents = data.pastEvents || [];
            archiveEnabled = !!data.archiveEnabled;
            isAdmin = !!me.isAdmin;
            adminCard.hidden = !isAdmin;
            render();
          } catch (e) {
            upcomingBody.innerHTML = `<p class="form-hint">Could not load events. ${esc(e.message)}</p>`;
          } finally {
            upcomingBody.setAttribute('aria-busy', 'false');
          }
        }
    
        load();
  })();
}
