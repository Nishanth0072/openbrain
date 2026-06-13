document.addEventListener('DOMContentLoaded', () => {

    // 1. Rich local knowledge database index (Guarantees articles/cases are found)
    const legalDatabase = [
        {
            id: 1,
            title: "Justice K.S. Puttaswamy v. Union of India",
            citation: "(2017) 10 SCC 1",
            category: "Constitutional",
            type: "Case Summary",
            excerpt: "A historic 9-judge bench of the Supreme Court unanimously affirmed that the Right to Privacy is a fundamental right protected under Article 21 of the Constitution. Striking deep implications for digital tracking, encryption, and biometric identification frameworks.",
            author: "Appellate Review",
            keywords: ["privacy", "fundamental rights", "article 21", "biometric", "data protection", "puttaswamy"]
        },
        {
            id: 2,
            title: "Understanding Digital Safe Harbor & Intermediary Liability",
            citation: "Tech Law Review Vol 14",
            category: "Corporate",
            type: "Expert Article",
            excerpt: "An extensive analysis of legal safe harbor guidelines for platform host compliance. Examining sections governing user-generated liability, takedown regimes, and the shifting standard towards proactive content verification algorithms.",
            author: "Nishanth Kumar, Corporate Counsel",
            keywords: ["safe harbor", "liability", "tech", "intermediary", "platform", "copyright", "section 230"]
        },
        {
            id: 3,
            title: "Shreya Singhal v. Union of India",
            citation: "AIR 2015 SC 1523",
            category: "Constitutional",
            type: "Case Summary",
            excerpt: "The landmark ruling invalidating Section 66A of the Information Technology Act. The Supreme Court struck down the statute entirely, holding that it unconstitutionally restricted online free speech and suffered from overbreadth.",
            author: "Tech Policy Board",
            keywords: ["speech", "freedom", "66a", "it act", "internet rights", "censorship"]
        },
        {
            id: 4,
            title: "Corporate Governance & Fiduciary Duties in Modern M&A",
            citation: "Corp Docket 2026",
            category: "Corporate",
            type: "Expert Article",
            excerpt: "Deconstructing recent corporate board liability updates during cross-border mergers. Focuses on due diligence requirements, protection against hostile minority shareholder litigation, and mitigating regulatory antitrust delays.",
            author: "A. Srinivasan, Senior Partner",
            keywords: ["mergers", "corporate", "governance", "m&a", "board duties", "shareholders", "antitrust"]
        },
        {
            id: 5,
            title: "Evolution of White Collar Criminal Investigations",
            citation: "Crim J. Report 88",
            category: "Criminal",
            type: "Expert Article",
            excerpt: "A deep look into statutory frameworks punishing financial fraud, insider trading, and corporate embezzlement. Discusses the shifting standard from purely physical evidence to cloud forensics and encrypted chat logs.",
            author: "Elena Rostov, Crim Defense",
            keywords: ["fraud", "criminal", "white collar", "embezzlement", "insider trading", "forensics"]
        },
        {
            id: 6,
            title: "Carlill v. Carbolic Smoke Ball Co.",
            citation: "[1893] QB 256",
            category: "Civil",
            type: "Case Summary",
            excerpt: "The foundational precedent in civil contracts defining unilateral offers. Establishes that performance of specified conditions constitutes absolute acceptance of an offer, cementing modern advertising liability norms.",
            author: "Contract Dept",
            keywords: ["contract", "civil", "unilateral", "offer", "acceptance", "liability"]
        }
    ];

    // 2. DOM Elements
    const searchInput = document.getElementById('legal-search');
    const clearBtn = document.getElementById('clear-search');
    const resultsGrid = document.getElementById('results-grid');
    const resultsCountText = document.getElementById('results-count');
    const statArticles = document.getElementById('stat-articles');
    const statCases = document.getElementById('stat-cases');
    const categoryContainer = document.getElementById('category-filters');
    const typeContainer = document.getElementById('type-filters');

    // 3. Current Filter State
    let activeCategory = 'all';
    let activeType = 'all';
    let currentSearchQuery = '';

    // Initialize Database Counters
    function updateCounters() {
        const totalArticles = legalDatabase.filter(item => item.type === 'Expert Article').length;
        const totalCases = legalDatabase.filter(item => item.type === 'Case Summary').length;
        if(statArticles) statArticles.textContent = totalArticles;
        if(statCases) statCases.textContent = totalCases;
    }

    // 4. Core Render Engine
    function renderResults() {
        // Filter elements
        const filtered = legalDatabase.filter(item => {
            // Category check
            const matchesCategory = (activeCategory === 'all' || item.category === activeCategory);
            // Type check
            const matchesType = (activeType === 'all' || item.type === activeType);
            
            // Text Search check
            let matchesSearch = true;
            if (currentSearchQuery) {
                const query = currentSearchQuery.toLowerCase().trim();
                matchesSearch = item.title.toLowerCase().includes(query) ||
                                item.citation.toLowerCase().includes(query) ||
                                item.excerpt.toLowerCase().includes(query) ||
                                item.keywords.some(kw => kw.includes(query));
            }

            return matchesCategory && matchesType && matchesSearch;
        });

        // Clear view
        resultsGrid.innerHTML = '';

        // Update count string
        if(filtered.length === 0) {
            resultsCountText.textContent = `0 resources matching filter`;
            resultsGrid.innerHTML = `
                <div class="no-results-view">
                    <h5>No Legal Resources Found</h5>
                    <p>We found nothing matching your criteria. Try typing broader legal definitions like "Privacy", "Contract", "Liability", or select another vertical.</p>
                </div>
            `;
            return;
        }

        resultsCountText.textContent = `Showing ${filtered.length} matching asset${filtered.length > 1 ? 's' : ''}`;

        // Build HTML strings
        filtered.forEach(item => {
            const card = document.createElement('div');
            card.className = 'legal-card';
            card.setAttribute('data-type', item.type);

            const badgeClass = item.type === 'Case Summary' ? 'badge-type-case' : 'badge-type-article';

            card.innerHTML = `
                <div class="card-top">
                    <div class="card-meta">
                        <span class="badge ${badgeClass}">${item.type}</span>
                        <span class="card-citation">${item.citation}</span>
                    </div>
                    <h4>${item.title}</h4>
                    <p class="card-excerpt">${item.excerpt}</p>
                </div>
                <div class="card-footer">
                    <span class="author-info">✍ ${item.author}</span>
                    <a href="#" class="read-more-link" onclick="event.preventDefault(); alert('Opening premium database folder window for: ${item.title}');">Brief View →</a>
                </div>
            `;
            resultsGrid.appendChild(card);
        });
    }

    // 5. Wire Search Event Handlers
    if(searchInput) {
        searchInput.addEventListener('input', (e) => {
            currentSearchQuery = e.target.value;
            if(currentSearchQuery.length > 0) {
                clearBtn.style.display = 'block';
            } else {
                clearBtn.style.display = 'none';
            }
            renderResults();
        });
    }

    if(clearBtn) {
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            currentSearchQuery = '';
            clearBtn.style.display = 'none';
            renderResults();
            searchInput.focus();
        });
    }

    // 6. Sidebar Filter Handlers
    if(categoryContainer) {
        categoryContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.filter-btn');
            if(!btn) return;
            
            categoryContainer.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeCategory = btn.getAttribute('data-category');
            renderResults();
        });
    }

    if(typeContainer) {
        typeContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('.filter-btn');
            if(!btn) return;

            typeContainer.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeType = btn.getAttribute('data-type');
            renderResults();
        });
    }

    // Run Initialization
    updateCounters();
    renderResults();
});
