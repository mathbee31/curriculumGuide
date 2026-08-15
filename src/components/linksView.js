// ─────────────────────────────────────────
//  components/linksView.js  —  참고 사이트 탭
// ─────────────────────────────────────────
import { escapeHtml } from '../utils/normalize.js';

let allLinks = [];
let activeCategory = '전체';

export function renderLinks(links) {
  allLinks = links;
  activeCategory = '전체';
  renderFilterBar();
  renderLinkCards();
}

// ── 카테고리 필터 바 ──────────────────────
function renderFilterBar() {
  const bar = document.getElementById('linksFilterBar');
  if (!bar) return;

  const categories = ['전체', ...new Set(allLinks.map(l => l.category).filter(Boolean))];

  bar.innerHTML = categories.map(cat => `
    <button class="links-filter-btn ${cat === activeCategory ? 'active' : ''}"
      data-cat="${escapeHtml(cat)}" type="button">
      ${escapeHtml(cat)}
      ${cat === '전체' ? '' : `<span style="opacity:0.7;font-weight:700;"> ${allLinks.filter(l => l.category === cat).length}</span>`}
    </button>
  `).join('');

  bar.addEventListener('click', e => {
    const btn = e.target.closest('.links-filter-btn');
    if (!btn) return;
    activeCategory = btn.dataset.cat;
    bar.querySelectorAll('.links-filter-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.cat === activeCategory)
    );
    renderLinkCards();
  });
}

// ── 링크 카드 렌더링 ──────────────────────
function renderLinkCards() {
  const el = document.getElementById('linksContent');
  if (!el) return;

  const filtered = activeCategory === '전체'
    ? allLinks
    : allLinks.filter(l => l.category === activeCategory);

  if (!filtered.length) {
    el.innerHTML = '<div class="links-empty">등록된 사이트가 없습니다.</div>';
    return;
  }

  // 카테고리별 그룹핑
  const groups = new Map();
  for (const link of filtered) {
    const cat = link.category || '기타';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(link);
  }

  el.innerHTML = [...groups.entries()].map(([cat, links]) => `
    <div class="links-section">
      <div class="links-section-title">
        ${escapeHtml(cat)}
        <span class="links-section-count">${links.length}개</span>
      </div>
      <div class="links-grid">
        ${links.map(link => linkCard(link)).join('')}
      </div>
    </div>
  `).join('');

  // 카드 클릭 → 새 탭 열기
  el.addEventListener('click', e => {
    const card = e.target.closest('.link-card');
    if (!card || !card.dataset.url) return;
    window.open(card.dataset.url, '_blank', 'noopener');
  });
}

function linkCard(link) {
  const tags = link.tags ? link.tags.split('|').map(t => t.trim()).filter(Boolean) : [];
  const displayUrl = (link.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

  return `
    <div class="link-card" data-url="${escapeHtml(link.url || '')}">
      <div class="link-card-top">
        <div class="link-card-name">${escapeHtml(link.name)}</div>
        <div class="link-card-arrow">↗</div>
      </div>
      ${link.url ? `<div class="link-card-url">${escapeHtml(displayUrl)}</div>` : ''}
      ${link.description ? `<div class="link-card-desc">${escapeHtml(link.description)}</div>` : ''}
      ${tags.length ? `
        <div class="link-card-tags">
          ${tags.map(t => `<span class="link-tag">${escapeHtml(t)}</span>`).join('')}
        </div>` : ''}
    </div>
  `;
}