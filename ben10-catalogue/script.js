const aliensData = [
    {
        id: "heatblast",
        name: "HEATBLAST",
        species: "Pyronite",
        playlist: "classic",
        icon: "🔥",
        homeWorld: "Pyros",
        description: "A magma-based lifeform capable of intense pyrokenesis, thermokinesis, and flight via fire-propelled boards.",
        stats: { attack: 90, speed: 65, durability: 75 },
        abilities: ["Fire Generation", "Magma Manipulation", "Cryo-Immunity"]
    },
    {
        id: "fourarms",
        name: "FOUR ARMS",
        species: "Tetramand",
        playlist: "classic",
        icon: "💪",
        homeWorld: "Khoros",
        description: "An armored behemoth possessing tremendous physical strength, dense muscle tissue, and extreme jumping prowess.",
        stats: { attack: 95, speed: 45, durability: 90 },
        abilities: ["Superhuman Strength", "Shockwave Clap", "High Durability"]
    },
    {
        id: "xlr8",
        name: "XLR8",
        species: "Kineceleran",
        playlist: "classic",
        icon: "⚡",
        homeWorld: "Kinet",
        description: "Manipulates friction to reach speeds exceeding 500 mph within seconds, turning environments into slowed realities.",
        stats: { attack: 60, speed: 100, durability: 40 },
        abilities: ["Hyper Speed", "Wall Running", "Prehensile Tail"]
    },
    {
        id: "swampfire",
        name: "SWAMPFIRE",
        species: "Methanosian",
        playlist: "af",
        icon: "🌱",
        homeWorld: "Methanos",
        description: "A plant-like structure blasting methane fire streams while regenerating limbs almost instantaneously.",
        stats: { attack: 85, speed: 60, durability: 85 },
        abilities: ["Chlorokinesis", "Methane Blasts", "Regeneration"]
    },
    {
        id: "humungousaur",
        name: "HUMUNGOUSAUR",
        species: "Vaxasaurian",
        playlist: "af",
        icon: "🦖",
        homeWorld: "Terradino",
        description: "Can increase his massive size at will, multiplying strength and building heavily armored dinosaur hide.",
        stats: { attack: 95, speed: 40, durability: 95 },
        abilities: ["Size Alteration", "Tail Thumping", "Extreme Power"]
    },
    {
        id: "ultimate_humungousaur",
        name: "ULT. HUMUNGOUSAUR",
        species: "Evolved Vaxasaurian",
        playlist: "ua",
        icon: "💣",
        homeWorld: "Terradino (Simulated)",
        description: "Ultimate evolution outfitted with bio-gattling projectile bone missiles and supreme heavy cybernetic shell armor.",
        stats: { attack: 100, speed: 35, durability: 100 },
        abilities: ["Bio-Gatling Shells", "Enhanced Mace Tail", "Max Armor"]
    }
];

const grid = document.getElementById('alien-grid');
const searchInput = document.getElementById('search-input');
const filterBtns = document.querySelectorAll('.filter-btn');
const modal = document.getElementById('alien-modal');
const modalData = document.getElementById('modal-data');
const closeModal = document.getElementById('close-modal');

let currentPlaylist = 'all';
let searchQuery = '';

function renderCatalogue() {
    grid.innerHTML = '';
    
    const filtered = aliensData.filter(alien => {
        const matchesPlaylist = currentPlaylist === 'all' || alien.playlist === currentPlaylist;
        const matchesSearch = alien.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                             alien.species.toLowerCase().includes(searchQuery.toLowerCase());
        return matchesPlaylist && matchesSearch;
    });

    filtered.forEach(alien => {
        const card = document.createElement('div');
        card.className = 'alien-card';
        card.innerHTML = `
            <div class="card-image-wrapper"><span>${alien.icon}</span></div>
            <div class="card-info">
                <div class="species-tag">${alien.species}</div>
                <div class="alien-name">${alien.name}</div>
                <div class="stats-summary">
                    <span>ATK: ${alien.stats.attack}</span>
                    <span>SPD: ${alien.stats.speed}</span>
                    <span>DUR: ${alien.stats.durability}</span>
                </div>
            </div>
        `;
        card.addEventListener('click', () => openAlienDetails(alien));
        grid.appendChild(card);
    });
}

function openAlienDetails(alien) {
    modalData.innerHTML = `
        <div class="modal-header-grid">
            <div class="modal-visual">${alien.icon}</div>
            <div class="modal-main-meta">
                <h2>${alien.name}</h2>
                <div class="species-tag" style="color: #00ff33;">SPECIES: ${alien.species} // HOMEWORLD: ${alien.homeWorld}</div>
                <p style="margin-top: 10px; line-height: 1.5; color: #b1d9b8;">${alien.description}</p>
            </div>
        </div>
        
        <div class="stats-container">
            <div class="stat-row">
                <div class="stat-label">ATTACK POTENTIAL (${alien.stats.attack}%)</div>
                <div class="stat-bar-container"><div class="stat-fill" id="atk-fill"></div></div>
            </div>
            <div class="stat-row">
                <div class="stat-label">VELOCITY / SPEED MATRIX (${alien.stats.speed}%)</div>
                <div class="stat-bar-container"><div class="stat-fill" id="spd-fill"></div></div>
            </div>
            <div class="stat-row">
                <div class="stat-label">STRUCTURAL DURABILITY (${alien.stats.durability}%)</div>
                <div class="stat-bar-container"><div class="stat-fill" id="dur-fill"></div></div>
            </div>
        </div>

        <div class="abilities-container">
            <h3>SIGNATURE COGNITIVE ABILITIES</h3>
            <div class="ability-chips">
                ${alien.abilities.map(ab => `<span class="chip">${ab}</span>`).join('')}
            </div>
        </div>
    `;
    
    modal.classList.add('active');
    
    // Animate bars
    setTimeout(() => {
        document.getElementById('atk-fill').style.width = `${alien.stats.attack}%`;
        document.getElementById('spd-fill').style.width = `${alien.stats.speed}%`;
        document.getElementById('dur-fill').style.width = `${alien.stats.durability}%`;
    }, 50);
}

searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderCatalogue();
});

filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPlaylist = btn.getAttribute('data-playlist');
        renderCatalogue();
    });
});

closeModal.addEventListener('click', () => modal.classList.remove('active'));
window.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });

// Initial Load
renderCatalogue();

