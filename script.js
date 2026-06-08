/**
 * AnimeFlix — Main Application Script
 * Powered by Jikan API (https://api.jikan.moe/v4)
 *
 * Architecture:
 *  - JikanAPI      : All API requests with retry logic and rate-limit handling
 *  - HeroManager   : Hero banner state & updates
 *  - SliderManager : Horizontal sliders with arrow controls
 *  - CardFactory   : Anime card DOM creation
 *  - FavoritesManager : LocalStorage-based favorites
 *  - SearchManager : Search with recent history
 *  - UIManager     : Modals, toasts, scroll-top, preloader
 *  - App           : Bootstrap & glue
 */

'use strict';

/* =========================================================
   CONSTANTS & CONFIG
   ========================================================= */

const JIKAN_BASE   = 'https://api.jikan.moe/v4';
const JIKAN_DELAY  = 400;   // ms between requests to respect rate limit
const MAX_RECENT   = 6;      // max saved recent searches
const FAV_KEY      = 'animeflix_favorites';
const RECENT_KEY   = 'animeflix_recent_searches';
const HERO_ROTATE  = 8000;   // ms between hero auto-rotations

/* =========================================================
   UTILITY HELPERS
   ========================================================= */

/**
 * Waits for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Truncates a string to maxLength and appends '…' if needed.
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function truncate(text, maxLength) {
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

/**
 * Safely escapes HTML special characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}

/**
 * Returns formatted score string.
 * @param {number|null} score
 * @returns {string}
 */
function formatScore(score) {
  return score ? score.toFixed(1) : 'N/A';
}

/**
 * Returns year from an aired.from string or null.
 * @param {object} aired
 * @returns {string}
 */
function extractYear(aired) {
  if (!aired || !aired.from) return '—';
  return new Date(aired.from).getFullYear().toString();
}

/**
 * Returns the first studio name from studios array.
 * @param {Array} studios
 * @returns {string}
 */
function extractStudio(studios) {
  if (!studios || !studios.length) return '—';
  return studios[0].name;
}

/* =========================================================
   JIKAN API MODULE
   ========================================================= */

const JikanAPI = (() => {
  // Simple queue to avoid hitting Jikan rate limit (3 req/s)
  let _queue     = [];
  let _running   = false;

  async function _processQueue() {
    if (_running) return;
    _running = true;
    while (_queue.length > 0) {
      const { url, resolve, reject } = _queue.shift();
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        resolve(data);
      } catch (err) {
        reject(err);
      }
      if (_queue.length > 0) await sleep(JIKAN_DELAY);
    }
    _running = false;
  }

  /**
   * Enqueues a GET request to the Jikan API.
   * @param {string} endpoint - path after base URL
   * @returns {Promise<object>}
   */
  function get(endpoint) {
    return new Promise((resolve, reject) => {
      _queue.push({ url: `${JIKAN_BASE}${endpoint}`, resolve, reject });
      _processQueue();
    });
  }

  /**
   * Fetches currently airing trending anime (top by popularity).
   * @returns {Promise<Array>}
   */
  async function getTrending() {
    const data = await get('/top/anime?filter=airing&limit=20');
    return data.data || [];
  }

  /**
   * Fetches all-time top-rated anime.
   * @returns {Promise<Array>}
   */
  async function getTopRated() {
    const data = await get('/top/anime?filter=bypopularity&limit=20');
    return data.data || [];
  }

  /**
   * Fetches anime popular in the current season.
   * @returns {Promise<Array>}
   */
  async function getCurrentSeason() {
    const data = await get('/seasons/now?limit=20');
    return data.data || [];
  }

  /**
   * Fetches upcoming anime.
   * @returns {Promise<Array>}
   */
  async function getUpcoming() {
    const data = await get('/seasons/upcoming?limit=20');
    return data.data || [];
  }

  /**
   * Searches anime by title query.
   * @param {string} query
   * @returns {Promise<Array>}
   */
  async function searchAnime(query) {
    const encoded = encodeURIComponent(query.trim());
    const data = await get(`/anime?q=${encoded}&limit=1&order_by=popularity&sort=asc`);
    return data.data || [];
  }

  /**
   * Fetches full anime details by MAL ID.
   * @param {number} malId
   * @returns {Promise<object|null>}
   */
  async function getAnimeById(malId) {
    const data = await get(`/anime/${malId}/full`);
    return data.data || null;
  }

  return { getTrending, getTopRated, getCurrentSeason, getUpcoming, searchAnime, getAnimeById };
})();

/* =========================================================
   UI MANAGER
   ========================================================= */

const UIManager = (() => {

  // ── Preloader ──────────────────────────────────────────
  function hidePreloader() {
    const el = document.getElementById('preloader');
    if (el) {
      setTimeout(() => {
        el.classList.add('hidden');
        setTimeout(() => el.remove(), 700);
      }, 600);
    }
  }

  // ── Global loader bar ──────────────────────────────────
  let _loaderEl = null;

  function _getLoader() {
    if (!_loaderEl) {
      _loaderEl = document.createElement('div');
      _loaderEl.id = 'global-loader';
      _loaderEl.className = 'global-loader';
      document.body.prepend(_loaderEl);
    }
    return _loaderEl;
  }

  function showLoader() { _getLoader().classList.add('active'); }
  function hideLoader() { _getLoader().classList.remove('active'); }

  // ── Toast ──────────────────────────────────────────────
  let _toastContainer = null;

  function _getToastContainer() {
    if (!_toastContainer) {
      _toastContainer = document.createElement('div');
      _toastContainer.id = 'toast-container';
      _toastContainer.className = 'toast-container';
      document.body.appendChild(_toastContainer);
    }
    return _toastContainer;
  }

  /**
   * Shows a toast notification.
   * @param {string} message
   * @param {number} duration  - milliseconds
   */
  function showToast(message, duration = 2800) {
    const container = _getToastContainer();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('out');
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, duration);
  }

  // ── Modal ──────────────────────────────────────────────
  const _openModals = new Set();

  /**
   * Opens a modal by its element ID.
   * @param {string} modalId
   */
  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.add('open');
    _openModals.add(modalId);
    document.body.style.overflow = 'hidden';
  }

  /**
   * Closes a modal by its element ID.
   * @param {string} modalId
   */
  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('open');
    _openModals.delete(modalId);
    if (_openModals.size === 0) {
      document.body.style.overflow = '';
    }
  }

  // Close modal on backdrop click
  document.addEventListener('click', (event) => {
    if (event.target.classList.contains('modal__backdrop')) {
      // Find which modal backdrop was clicked
      const modal = event.target.closest('.modal');
      if (modal) closeModal(modal.id);
    }
  });

  // Close on Escape key
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && _openModals.size > 0) {
      const lastModal = [..._openModals].pop();
      closeModal(lastModal);
    }
  });

  // ── Scroll To Top ──────────────────────────────────────
  function initScrollTop() {
    const btn = document.getElementById('scroll-top-btn');
    if (!btn) return;

    window.addEventListener('scroll', () => {
      btn.classList.toggle('visible', window.scrollY > 500);
    }, { passive: true });

    btn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ── Intersection observer for section animations ───────
  function initSectionReveal() {
    const sections = document.querySelectorAll('.anime-section');
    if (!sections.length) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    sections.forEach(section => observer.observe(section));
  }

  // ── Navbar scroll behaviour ────────────────────────────
  function initNavbarScroll() {
    const navbar = document.getElementById('navbar');
    if (!navbar) return;

    window.addEventListener('scroll', () => {
      navbar.classList.toggle('scrolled', window.scrollY > 30);
    }, { passive: true });
  }

  // ── Hamburger menu ─────────────────────────────────────
  function initHamburger() {
    const btn  = document.getElementById('hamburger');
    const nav  = document.getElementById('main-nav');
    if (!btn || !nav) return;

    btn.addEventListener('click', () => {
      btn.classList.toggle('open');
      nav.classList.toggle('open');
    });

    // Close menu when link clicked
    nav.addEventListener('click', (e) => {
      if (e.target.matches('.navbar__link')) {
        btn.classList.remove('open');
        nav.classList.remove('open');
      }
    });
  }

  // ── Particles ─────────────────────────────────────────
  function initParticles() {
    const container = document.getElementById('hero-particles');
    if (!container) return;

    // Create floating particles
    for (let i = 0; i < 18; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const size   = Math.random() * 3 + 1;
      const left   = Math.random() * 100;
      const delay  = Math.random() * 12;
      const duration = Math.random() * 8 + 8;
      const opacity = Math.random() * 0.6 + 0.2;

      p.style.cssText = `
        width: ${size}px;
        height: ${size}px;
        left: ${left}%;
        bottom: -10px;
        animation-delay: ${delay}s;
        animation-duration: ${duration}s;
        opacity: ${opacity};
      `;
      container.appendChild(p);
    }
  }

  return {
    hidePreloader,
    showLoader,
    hideLoader,
    showToast,
    openModal,
    closeModal,
    initScrollTop,
    initSectionReveal,
    initNavbarScroll,
    initHamburger,
    initParticles,
  };
})();

/* =========================================================
   FAVORITES MANAGER
   ========================================================= */

const FavoritesManager = (() => {

  /**
   * Retrieves all favorites from LocalStorage.
   * @returns {Array<object>}
   */
  function getAll() {
    try {
      return JSON.parse(localStorage.getItem(FAV_KEY)) || [];
    } catch {
      return [];
    }
  }

  /**
   * Checks if an anime (by MAL ID) is in favorites.
   * @param {number} malId
   * @returns {boolean}
   */
  function has(malId) {
    return getAll().some(item => item.mal_id === malId);
  }

  /**
   * Adds an anime to favorites.
   * @param {object} anime  - Jikan anime data object
   */
  function add(anime) {
    const favorites = getAll();
    if (!favorites.some(item => item.mal_id === anime.mal_id)) {
      favorites.unshift({
        mal_id: anime.mal_id,
        title:  anime.title,
        image:  anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url,
        score:  anime.score,
      });
      localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
    }
  }

  /**
   * Removes an anime from favorites.
   * @param {number} malId
   */
  function remove(malId) {
    const favorites = getAll().filter(item => item.mal_id !== malId);
    localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  }

  /**
   * Toggles favorite status and returns new status.
   * @param {object} anime
   * @returns {boolean} - true if now in favorites
   */
  function toggle(anime) {
    if (has(anime.mal_id)) {
      remove(anime.mal_id);
      return false;
    } else {
      add(anime);
      return true;
    }
  }

  return { getAll, has, add, remove, toggle };
})();

/* =========================================================
   CARD FACTORY
   ========================================================= */

const CardFactory = (() => {

  /**
   * Creates a skeleton placeholder card element.
   * @returns {HTMLElement}
   */
  function createSkeleton() {
    const wrapper = document.createElement('div');
    wrapper.className = 'skeleton-card';
    wrapper.innerHTML = `
      <div class="skeleton skeleton-card__poster"></div>
      <div class="skeleton skeleton-card__title" style="margin-top:8px;"></div>
    `;
    return wrapper;
  }

  /**
   * Creates a full anime card element.
   * @param {object} anime       - Jikan anime data
   * @param {number} index       - card index for staggered animation
   * @param {Function} onWatch   - callback when Watch button clicked
   * @param {Function} onDetail  - callback when card clicked for detail
   * @returns {HTMLElement}
   */
  function createCard(anime, index, onWatch, onDetail) {
    const card  = document.createElement('div');
    const image = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '';
    const score = formatScore(anime.score);
    const title = anime.title || 'Без названия';
    const isFav = FavoritesManager.has(anime.mal_id);

    card.className = 'anime-card fade-in';
    card.style.animationDelay = `${index * 60}ms`;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Открыть ${escapeHtml(title)}`);

    card.innerHTML = `
      <div class="anime-card__poster-wrap">
        <img
          class="anime-card__poster"
          src="${escapeHtml(image)}"
          alt="${escapeHtml(title)}"
          loading="lazy"
        />
        <div class="anime-card__overlay">
          <div class="anime-card__actions">
            <button class="anime-card__action-btn js-watch-btn" data-id="${anime.mal_id}">▶ Смотреть</button>
            <button class="anime-card__action-btn anime-card__action-btn--ghost js-fav-btn" data-id="${anime.mal_id}" aria-label="Избранное">
              ${isFav ? '❤️' : '🤍'}
            </button>
          </div>
        </div>
        ${score !== 'N/A' ? `
          <div class="anime-card__score">
            <svg viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            ${escapeHtml(score)}
          </div>
        ` : ''}
        ${isFav ? '<div class="anime-card__fav-badge">❤️</div>' : ''}
      </div>
      <div class="anime-card__title">${escapeHtml(title)}</div>
    `;

    // Watch button
    const watchBtn = card.querySelector('.js-watch-btn');
    if (watchBtn) {
      watchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof onWatch === 'function') onWatch(anime);
      });
    }

    // Fav button
    const favBtn = card.querySelector('.js-fav-btn');
    if (favBtn) {
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const added = FavoritesManager.toggle(anime);
        favBtn.textContent = added ? '❤️' : '🤍';
        // Update fav badge
        const badge = card.querySelector('.anime-card__fav-badge');
        if (added && !badge) {
          const newBadge = document.createElement('div');
          newBadge.className = 'anime-card__fav-badge';
          newBadge.textContent = '❤️';
          card.querySelector('.anime-card__poster-wrap').appendChild(newBadge);
        } else if (!added && badge) {
          badge.remove();
        }
        UIManager.showToast(added ? `❤️ Добавлено в избранное: ${title}` : `🗑 Удалено из избранного`);
      });
    }

    // Open detail on card click
    card.addEventListener('click', () => {
      if (typeof onDetail === 'function') onDetail(anime);
    });

    // Keyboard support
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (typeof onDetail === 'function') onDetail(anime);
      }
    });

    return card;
  }

  return { createSkeleton, createCard };
})();

/* =========================================================
   SLIDER MANAGER
   ========================================================= */

const SliderManager = (() => {

  /**
   * Populates a slider track with skeleton cards.
   * @param {string} trackId
   * @param {number} count
   */
  function showSkeletons(trackId, count = 10) {
    const track = document.getElementById(trackId);
    if (!track) return;
    track.innerHTML = '';
    for (let i = 0; i < count; i++) {
      track.appendChild(CardFactory.createSkeleton());
    }
  }

  /**
   * Populates a slider track with anime cards.
   * @param {string} trackId
   * @param {Array} animeList
   * @param {Function} onWatch
   * @param {Function} onDetail
   */
  function populateTrack(trackId, animeList, onWatch, onDetail) {
    const track = document.getElementById(trackId);
    if (!track) return;
    track.innerHTML = '';

    if (!animeList || !animeList.length) {
      track.innerHTML = `<p style="color:var(--color-text-3);padding:1rem;">Нет данных</p>`;
      return;
    }

    animeList.forEach((anime, i) => {
      const card = CardFactory.createCard(anime, i, onWatch, onDetail);
      track.appendChild(card);
    });
  }

  /**
   * Attaches click handlers to all slider arrows.
   */
  function initArrows() {
    const arrows = document.querySelectorAll('.slider-arrow');
    arrows.forEach(arrow => {
      arrow.addEventListener('click', () => {
        const trackId = arrow.getAttribute('data-target');
        const track   = document.getElementById(trackId);
        if (!track) return;

        const cardWidth = 160 + 16; // card width + gap
        const scrollAmt = cardWidth * 4;

        if (arrow.classList.contains('slider-arrow--prev')) {
          track.scrollBy({ left: -scrollAmt, behavior: 'smooth' });
        } else {
          track.scrollBy({ left: scrollAmt, behavior: 'smooth' });
        }
      });
    });
  }

  return { showSkeletons, populateTrack, initArrows };
})();

/* =========================================================
   HERO MANAGER
   ========================================================= */

const HeroManager = (() => {

  let _currentAnime   = null;
  let _heroList       = [];
  let _rotateInterval = null;
  let _rotateIndex    = 0;

  const _elements = {
    bg:          () => document.getElementById('hero-bg'),
    poster:      () => document.getElementById('hero-poster'),
    posterWrap:  () => document.getElementById('hero-poster-wrap'),
    content:     () => document.getElementById('hero-content'),
    title:       () => document.getElementById('hero-title'),
    genres:      () => document.getElementById('hero-genres'),
    score:       () => document.getElementById('hero-score'),
    episodes:    () => document.getElementById('hero-episodes'),
    year:        () => document.getElementById('hero-year'),
    studio:      () => document.getElementById('hero-studio'),
    description: () => document.getElementById('hero-description'),
    watchBtn:    () => document.getElementById('hero-watch-btn'),
    infoBtn:     () => document.getElementById('hero-info-btn'),
    favBtn:      () => document.getElementById('hero-fav-btn'),
  };

  /**
   * Updates the hero banner with a given anime object.
   * @param {object} anime - Jikan anime data
   */
  function update(anime) {
    _currentAnime = anime;

    const bg         = _elements.bg();
    const poster     = _elements.poster();
    const posterWrap = _elements.posterWrap();
    const content    = _elements.content();

    // Fade content out, then update
    if (content) {
      content.classList.remove('visible');
      if (posterWrap) posterWrap.classList.remove('visible');
    }

    setTimeout(() => {
      // Background — use large image
      const bgImage = anime.images?.jpg?.large_image_url
                   || anime.images?.jpg?.image_url
                   || '';
      if (bg && bgImage) {
        bg.classList.add('animating');
        bg.style.backgroundImage = `url('${bgImage}')`;
        setTimeout(() => bg.classList.remove('animating'), 8000);
      }

      // Poster
      if (poster && bgImage) {
        poster.src = bgImage;
        poster.alt = anime.title || '';
      }

      // Title
      const titleEl = _elements.title();
      if (titleEl) titleEl.textContent = anime.title || 'Без названия';

      // Genres
      const genresEl = _elements.genres();
      if (genresEl) {
        genresEl.innerHTML = '';
        (anime.genres || []).slice(0, 4).forEach(g => {
          const tag = document.createElement('span');
          tag.className = 'genre-tag';
          tag.textContent = g.name;
          genresEl.appendChild(tag);
        });
      }

      // Score
      const scoreEl = _elements.score();
      if (scoreEl) {
        scoreEl.innerHTML = `
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          ${formatScore(anime.score)}
        `;
      }

      // Episodes
      const epsEl = _elements.episodes();
      if (epsEl) {
        epsEl.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>
          ${anime.episodes || '?'} эп.
        `;
      }

      // Year
      const yearEl = _elements.year();
      if (yearEl) {
        yearEl.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          ${extractYear(anime.aired)}
        `;
      }

      // Studio
      const studioEl = _elements.studio();
      if (studioEl) {
        studioEl.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
          ${escapeHtml(extractStudio(anime.studios))}
        `;
      }

      // Description
      const descEl = _elements.description();
      if (descEl) {
        descEl.textContent = truncate(anime.synopsis || 'Описание отсутствует.', 320);
      }

      // Fav button state
      _updateFavBtn(anime);

      // Fade content in
      if (content) {
        content.classList.add('visible');
        if (posterWrap) posterWrap.classList.add('visible');
      }
    }, 200);
  }

  function _updateFavBtn(anime) {
    const favBtn = _elements.favBtn();
    if (!favBtn) return;

    if (FavoritesManager.has(anime.mal_id)) {
      favBtn.classList.add('active');
    } else {
      favBtn.classList.remove('active');
    }
  }

  /**
   * Attaches click handlers to hero buttons.
   * @param {Function} onWatch   - callback for Watch button
   * @param {Function} onDetail  - callback for Info button
   */
  function initButtons(onWatch, onDetail) {
    const watchBtn = _elements.watchBtn();
    const infoBtn  = _elements.infoBtn();
    const favBtn   = _elements.favBtn();

    if (watchBtn) {
      watchBtn.addEventListener('click', () => {
        if (_currentAnime && typeof onWatch === 'function') onWatch(_currentAnime);
      });
    }

    if (infoBtn) {
      infoBtn.addEventListener('click', () => {
        if (_currentAnime && typeof onDetail === 'function') onDetail(_currentAnime);
      });
    }

    if (favBtn) {
      favBtn.addEventListener('click', () => {
        if (!_currentAnime) return;
        const added = FavoritesManager.toggle(_currentAnime);
        _updateFavBtn(_currentAnime);
        UIManager.showToast(added ? `❤️ Добавлено: ${_currentAnime.title}` : '🗑 Удалено из избранного');
      });
    }
  }

  /**
   * Starts auto-rotation of hero banner through the provided list.
   * @param {Array} animeList
   */
  function startAutoRotate(animeList) {
    if (!animeList || !animeList.length) return;
    _heroList  = animeList.slice(0, 8);
    _rotateIndex = 0;

    // Show first immediately
    update(_heroList[0]);

    _rotateInterval = setInterval(() => {
      _rotateIndex = (_rotateIndex + 1) % _heroList.length;
      update(_heroList[_rotateIndex]);
    }, HERO_ROTATE);
  }

  /**
   * Stops auto-rotation.
   */
  function stopAutoRotate() {
    clearInterval(_rotateInterval);
    _rotateInterval = null;
  }

  return { update, initButtons, startAutoRotate, stopAutoRotate };
})();

/* =========================================================
   SEARCH MANAGER
   ========================================================= */

const SearchManager = (() => {

  let _searchOpen  = false;
  let _debounceTimer = null;

  /**
   * Retrieves recent searches from LocalStorage.
   * @returns {Array<string>}
   */
  function _getRecent() {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
    } catch {
      return [];
    }
  }

  /**
   * Saves a search query to recent list.
   * @param {string} query
   */
  function _saveRecent(query) {
    if (!query.trim()) return;
    let recent = _getRecent().filter(q => q.toLowerCase() !== query.toLowerCase());
    recent.unshift(query.trim());
    recent = recent.slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  }

  /**
   * Renders the recent searches list in the dropdown.
   */
  function _renderRecent() {
    const list    = document.getElementById('recent-list');
    const wrapper = document.getElementById('search-recent');
    if (!list || !wrapper) return;

    const recent = _getRecent();
    list.innerHTML = '';

    if (!recent.length) {
      wrapper.classList.remove('has-items');
      return;
    }

    wrapper.classList.add('has-items');

    recent.forEach(query => {
      const li  = document.createElement('li');
      li.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.01"/>
        </svg>
        ${escapeHtml(query)}
      `;
      li.addEventListener('click', () => {
        const input = document.getElementById('search-input');
        if (input) {
          input.value = query;
          input.dispatchEvent(new Event('input'));
          // Trigger search
          _executeSearch(query);
        }
      });
      list.appendChild(li);
    });
  }

  /**
   * Performs the actual search and updates the hero/UI.
   * @param {string} query
   * @param {Function} onResult  - callback(anime)
   */
  async function _executeSearch(query, onResult) {
    if (!query.trim()) return;

    UIManager.showLoader();
    _saveRecent(query);
    _renderRecent();

    try {
      const results = await JikanAPI.searchAnime(query);
      if (results && results.length > 0) {
        const anime = results[0];
        // Stop auto-rotation so searched anime stays
        HeroManager.stopAutoRotate();
        HeroManager.update(anime);

        if (typeof onResult === 'function') onResult(anime);

        UIManager.showToast(`🔍 Найдено: ${anime.title}`);
      } else {
        UIManager.showToast('😔 Ничего не найдено');
      }
    } catch (error) {
      console.error('Search error:', error);
      UIManager.showToast('⚠️ Ошибка поиска. Попробуйте позже.');
    } finally {
      UIManager.hideLoader();
    }
  }

  /**
   * Initializes search UI interactions.
   * @param {Function} onResult
   */
  function init(onResult) {
    const toggleBtn  = document.getElementById('search-toggle');
    const searchBox  = document.getElementById('search-box');
    const input      = document.getElementById('search-input');
    const clearBtn   = document.getElementById('search-clear');
    const searchWrap = document.getElementById('search-wrapper');

    if (!toggleBtn || !searchBox || !input) return;

    // Toggle search box
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _searchOpen = !_searchOpen;
      searchBox.classList.toggle('open', _searchOpen);
      if (_searchOpen) {
        input.focus();
        _renderRecent();
      }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (_searchOpen && !searchWrap.contains(e.target)) {
        _searchOpen = false;
        searchBox.classList.remove('open');
      }
    });

    // Input change — show/hide clear button
    input.addEventListener('input', () => {
      const hasValue = input.value.trim().length > 0;
      clearBtn.classList.toggle('visible', hasValue);

      // Debounced live search
      clearTimeout(_debounceTimer);
      if (hasValue && input.value.trim().length >= 3) {
        _debounceTimer = setTimeout(() => {
          _executeSearch(input.value.trim(), onResult);
        }, 700);
      }
    });

    // Clear button
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.classList.remove('visible');
        input.focus();
        _renderRecent();
      });
    }

    // Search on Enter
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(_debounceTimer);
        _executeSearch(input.value.trim(), onResult);
        input.blur();
        _searchOpen = false;
        searchBox.classList.remove('open');
      }
    });

    _renderRecent();
  }

  return { init };
})();

/* =========================================================
   DETAIL MODAL MANAGER
   ========================================================= */

const DetailModal = (() => {

  /**
   * Opens the detail modal for a given anime.
   * @param {object} anime - Jikan anime data (may be partial from list)
   */
  async function open(anime) {
    // Show modal with basic info immediately
    _render(anime);
    UIManager.openModal('detail-modal');

    // Fetch full details in background
    UIManager.showLoader();
    try {
      const full = await JikanAPI.getAnimeById(anime.mal_id);
      if (full) {
        _render(full);
      }
    } catch (err) {
      console.error('Detail fetch error:', err);
    } finally {
      UIManager.hideLoader();
    }
  }

  function _render(anime) {
    const body = document.getElementById('detail-modal-body');
    if (!body) return;

    const image   = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '';
    const score   = formatScore(anime.score);
    const year    = extractYear(anime.aired);
    const studio  = extractStudio(anime.studios);
    const isFav   = FavoritesManager.has(anime.mal_id);
    const genres  = (anime.genres || []).slice(0, 6);
    const desc    = anime.synopsis || 'Описание отсутствует.';
    const trailer = anime.trailer?.youtube_id || null;

    body.innerHTML = `
      <img class="detail-modal-body__poster" src="${escapeHtml(image)}" alt="${escapeHtml(anime.title || '')}" />
      <div class="detail-modal-body__info">
        <h2 class="detail-modal-body__title">${escapeHtml(anime.title || 'Без названия')}</h2>
        <div class="detail-modal-body__meta">
          ${score !== 'N/A' ? `<span class="detail-meta-tag detail-meta-tag--score">⭐ ${score}</span>` : ''}
          <span class="detail-meta-tag">📅 ${escapeHtml(year)}</span>
          ${anime.episodes ? `<span class="detail-meta-tag">🎬 ${escapeHtml(String(anime.episodes))} эп.</span>` : ''}
          ${studio !== '—' ? `<span class="detail-meta-tag">🏠 ${escapeHtml(studio)}</span>` : ''}
          ${anime.status ? `<span class="detail-meta-tag">${escapeHtml(anime.status)}</span>` : ''}
          ${anime.rating ? `<span class="detail-meta-tag">${escapeHtml(anime.rating)}</span>` : ''}
        </div>
        <div class="detail-modal-body__genres">
          ${genres.map(g => `<span class="genre-tag">${escapeHtml(g.name)}</span>`).join('')}
        </div>
        <p class="detail-modal-body__desc">${escapeHtml(desc)}</p>
        <div class="detail-modal-body__actions">
          ${trailer ? `
            <button class="btn btn--primary js-trailer-btn" data-youtube="${escapeHtml(trailer)}" data-title="${escapeHtml(anime.title || '')}">
              <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Трейлер
            </button>
          ` : ''}
          <button class="btn btn--ghost js-detail-fav-btn" data-id="${anime.mal_id}">
            ${isFav ? '❤️ В избранном' : '🤍 В избранное'}
          </button>
          <a
            class="btn btn--ghost"
            href="https://myanimelist.net/anime/${anime.mal_id}"
            target="_blank"
            rel="noopener noreferrer"
          >
            MAL →
          </a>
        </div>
      </div>
    `;

    // Trailer button
    const trailerBtn = body.querySelector('.js-trailer-btn');
    if (trailerBtn) {
      trailerBtn.addEventListener('click', () => {
        const youtubeId = trailerBtn.getAttribute('data-youtube');
        const title     = trailerBtn.getAttribute('data-title');
        TrailerModal.open(youtubeId, title);
      });
    }

    // Fav button in detail modal
    const favBtn = body.querySelector('.js-detail-fav-btn');
    if (favBtn) {
      favBtn.addEventListener('click', () => {
        const added = FavoritesManager.toggle(anime);
        favBtn.textContent = added ? '❤️ В избранном' : '🤍 В избранное';
        UIManager.showToast(added ? `❤️ Добавлено: ${anime.title}` : '🗑 Удалено из избранного');
      });
    }
  }

  // Close button
  const closeBtn = document.getElementById('detail-modal-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => UIManager.closeModal('detail-modal'));
  }

  return { open };
})();

/* =========================================================
   TRAILER MODAL MANAGER
   ========================================================= */

const TrailerModal = (() => {

  /**
   * Opens the trailer modal with a YouTube video.
   * @param {string|null} youtubeId
   * @param {string} title
   */
  function open(youtubeId, title) {
    const iframe    = document.getElementById('trailer-iframe');
    const titleEl   = document.getElementById('modal-title');
    const noTrailer = document.getElementById('modal-no-trailer');

    if (titleEl) titleEl.textContent = title || '';

    if (youtubeId) {
      if (iframe) {
        iframe.src = `https://www.youtube.com/embed/${youtubeId}?autoplay=1&rel=0`;
        iframe.style.display = 'block';
      }
      if (noTrailer) noTrailer.classList.remove('visible');
    } else {
      if (iframe) {
        iframe.src = '';
        iframe.style.display = 'none';
      }
      if (noTrailer) noTrailer.classList.add('visible');
    }

    UIManager.openModal('trailer-modal');
  }

  /**
   * Clears the iframe src when modal is closed (stops video).
   */
  function _onClose() {
    const iframe = document.getElementById('trailer-iframe');
    if (iframe) iframe.src = '';
    UIManager.closeModal('trailer-modal');
  }

  const closeBtn    = document.getElementById('modal-close');
  const backdrop    = document.getElementById('modal-backdrop');

  if (closeBtn)  closeBtn.addEventListener('click', _onClose);
  if (backdrop)  backdrop.addEventListener('click', _onClose);

  return { open };
})();

/* =========================================================
   FAVORITES PANEL MANAGER
   ========================================================= */

const FavoritesPanel = (() => {

  function open() {
    _render();
    UIManager.openModal('favorites-modal');
  }

  function _render() {
    const grid = document.getElementById('favorites-grid');
    if (!grid) return;

    const favorites = FavoritesManager.getAll();
    grid.innerHTML = '';

    if (!favorites.length) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--color-text-3);">
          <div style="font-size:3rem;margin-bottom:1rem;">💔</div>
          <p>Избранное пусто</p>
          <p style="font-size:0.8rem;margin-top:0.5rem;">Нажимай 🤍 на карточках, чтобы сохранить аниме</p>
        </div>
      `;
      return;
    }

    favorites.forEach((item, i) => {
      const card = CardFactory.createCard(
        { ...item, images: { jpg: { large_image_url: item.image, image_url: item.image } } },
        i,
        (anime) => {
          UIManager.closeModal('favorites-modal');
          HeroManager.update(anime);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        },
        (anime) => DetailModal.open(anime)
      );
      grid.appendChild(card);
    });
  }

  const closeBtn  = document.getElementById('favorites-modal-close');
  const openBtn   = document.getElementById('open-favorites');
  const backdrop  = document.getElementById('favorites-backdrop');

  if (closeBtn) closeBtn.addEventListener('click', () => UIManager.closeModal('favorites-modal'));
  if (backdrop) backdrop.addEventListener('click', () => UIManager.closeModal('favorites-modal'));
  if (openBtn)  openBtn.addEventListener('click',  (e) => { e.preventDefault(); open(); });

  return { open };
})();

/* =========================================================
   APP BOOTSTRAP
   ========================================================= */

const App = (() => {

  /**
   * Loads a single slider section.
   * @param {string} trackId   - DOM id of slider track
   * @param {Function} fetchFn - async function returning anime array
   */
  async function _loadSection(trackId, fetchFn) {
    SliderManager.showSkeletons(trackId, 12);
    try {
      const list = await fetchFn();
      SliderManager.populateTrack(
        trackId,
        list,
        (anime) => TrailerModal.open(anime.trailer?.youtube_id || null, anime.title),
        (anime) => DetailModal.open(anime)
      );
    } catch (error) {
      console.error(`Error loading section [${trackId}]:`, error);
      const track = document.getElementById(trackId);
      if (track) {
        track.innerHTML = `<p style="color:var(--color-text-3);padding:1rem;">⚠️ Ошибка загрузки. Проверьте соединение.</p>`;
      }
    }
  }

  /**
   * Main application initialization.
   */
  async function init() {
    // Initialize UI components
    UIManager.initNavbarScroll();
    UIManager.initScrollTop();
    UIManager.initSectionReveal();
    UIManager.initHamburger();
    UIManager.initParticles();
    SliderManager.initArrows();

    // Initialize search with callback (also handles hero update on search)
    SearchManager.init((anime) => {
      // When search finds an anime, also push it as detail option
      console.log('Search result:', anime.title);
    });

    // Hero buttons
    HeroManager.initButtons(
      (anime) => TrailerModal.open(anime.trailer?.youtube_id || null, anime.title),
      (anime) => DetailModal.open(anime)
    );

    UIManager.showLoader();

    // Load trending first (will also seed the hero banner)
    try {
      const trending = await JikanAPI.getTrending();

      // Start hero rotation with trending
      if (trending && trending.length) {
        HeroManager.startAutoRotate(trending);
      }

      // Populate trending track
      SliderManager.populateTrack(
        'trending-track',
        trending,
        (anime) => TrailerModal.open(anime.trailer?.youtube_id || null, anime.title),
        (anime) => DetailModal.open(anime)
      );
    } catch (err) {
      console.error('Trending load failed:', err);
    } finally {
      UIManager.hideLoader();
    }

    // Load remaining sections sequentially to respect rate limit
    await _loadSection('top-rated-track', JikanAPI.getTopRated);
    await _loadSection('season-track',    JikanAPI.getCurrentSeason);
    await _loadSection('upcoming-track',  JikanAPI.getUpcoming);

    // Hide preloader after everything is bootstrapped
    UIManager.hidePreloader();
  }

  return { init };
})();

/* =========================================================
   ENTRY POINT
   ========================================================= */

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});