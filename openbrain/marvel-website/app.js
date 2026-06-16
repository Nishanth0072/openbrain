
document.addEventListener('DOMContentLoaded', () => {
    console.log("⚡ Marvel Nexus Matrix Initialized Successfully.");

    // --- NAVIGATION GLIDE LOGIC ---
    const navLinks = document.querySelectorAll('.nav-link');
    
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const targetId = link.getAttribute('href');
            
            // Only prevent default if it's an internal hash link
            if (targetId && targetId.startsWith('#')) {
                e.preventDefault();
                const targetSection = document.querySelector(targetId);
                
                if (targetSection) {
                    targetSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }

                // Update Active State
                navLinks.forEach(l => l.classList.remove('active'));
                link.classList.add('active');
            }
        });
    });

    // --- SEGMENTED MATRIX FILTER SYSTEM ---
    const filterButtons = document.querySelectorAll('.control-btn');
    const matrixCards = document.querySelectorAll('.matrix-card');
    const glidingBox = document.querySelector('.gliding-box');

    function updateGlidingBox(activeBtn) {
        if (glidingBox && activeBtn) {
            glidingBox.style.width = `${activeBtn.offsetWidth}px`;
            glidingBox.style.left = `${activeBtn.offsetLeft}px`;
        }
    }

    // Initialize position of fluid gliding box indicator
    if (filterButtons.length > 0) {
        setTimeout(() => updateGlidingBox(filterButtons[0]), 150);
    }

    filterButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Update Active State Visuals
            filterButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            updateGlidingBox(button);

            // Filter Performance Execution
            const filterValue = button.getAttribute('data-filter');

            matrixCards.forEach(card => {
                const team = card.getAttribute('data-team');
                
                // Reset card animations smoothly
                card.style.transform = 'scale(0.95)';
                card.style.opacity = '0';

                setTimeout(() => {
                    if (filterValue === 'all' || team === filterValue) {
                        card.style.display = 'block';
                        setTimeout(() => {
                            card.style.transform = 'scale(1)';
                            card.style.opacity = '1';
                        }, 50);
                    } else {
                        card.style.display = 'none';
                    }
                }, 200);
            });
        });
    });

    // Recalculate gliding box size on layout adjustments
    window.addEventListener('resize', () => {
        const activeBtn = document.querySelector('.control-btn.active');
        updateGlidingBox(activeBtn);
    });

    // --- PRIMORDIAL SINGULARITY INTERACTIVE CONSOLE ---
    const gemNodes = document.querySelectorAll('.node-gem');
    const consoleMonitor = document.getElementById('consoleMonitor');
    const statusIndicator = consoleMonitor?.querySelector('.status-indicator');
    const consoleTitle = consoleMonitor?.querySelector('.console-title');
    const consoleDesc = consoleMonitor?.querySelector('.console-desc');

    const cosmicIntel = {
        space: {
            title: "Space Stone // Tesseract Matrix",
            desc: "Establishes a localized dimensional warp. Containment vessel holding steady at 98.4%. Quantum tunneling parameters allow immediate spatial displacement across active multi-universal hexes.",
            status: "CONTAINED // ACTIVE"
        },
        reality: {
            title: "Reality Stone // Aether Fluidity",
            desc: "Simulating structural conversion laws. Warning: Surrounding localized matter showing conversion properties to dark matter formulas. Keep reinforcement shields over max threshold.",
            status: "CRITICAL ALPHA // MONITORING"
        },
        power: {
            title: "Power Stone // Cosmic Battery",
            desc: "Raw kinetic energy output passing 4.2 Exawatts. Structural integrity grids are holding but heat dissipation units are running near maximum capacity. Do not come into direct contact.",
            status: "OVERFLOW WARNING // STABLE"
        },
        mind: {
            title: "Mind Stone // Scepter Core",
            desc: "Sub-network neurological signals syncing with external firewalls. Synaptic frequencies operating at 430 Hz. High level threat warning: Sentient AI patterns emerging within containment logs.",
            status: "NEURAL SYNC ONTIME"
        },
        soul: {
            title: "Soul Stone // Vormir Singularity",
            desc: "Exotic radiation measurements undetectable via traditional electronic mechanics. Requires biological diagnostic link to register active plasma fields. Proceed with absolute quarantine measures.",
            status: "UNKNOWN // ENCRYPTED"
        },
        time: {
            title: "Time Stone // Eye of Agamotto",
            desc: "Temporal regression variance locked at zero loops per microsecond. Localized causality stabilizers keeping timeline structure intact. Do not decouple green light spectrum channels.",
            status: "SECURE // SYNCED"
        }
    };

    gemNodes.forEach(node => {
        node.addEventListener('click', () => {
            const stoneType = node.getAttribute('data-stone');
            const intel = cosmicIntel[stoneType];

            if (intel && consoleMonitor) {
                // Apply interface disruption flash animation
                consoleMonitor.style.animation = 'none';
                void consoleMonitor.offsetHeight; // Force DOM reflow
                consoleMonitor.style.animation = 'pulse 0.4s ease';

                // Inject updated metadata vectors smoothly
                if (statusIndicator) {
                    statusIndicator.textContent = intel.status;
                    // Dynamically shift visual priority flags
                    if (intel.status.includes('CRITICAL') || intel.status.includes('WARNING')) {
                        statusIndicator.style.background = 'rgba(255, 62, 62, 0.15)';
                        statusIndicator.style.color = '#ff3e3e';
                    } else {
                        statusIndicator.style.background = 'rgba(0, 255, 242, 0.1)';
                        statusIndicator.style.color = 'var(--accent)';
                    }
                }
                if (consoleTitle) consoleTitle.textContent = intel.title;
                if (consoleDesc) consoleDesc.textContent = intel.desc;

                // Adjust active focus outline matrices across selectors
                gemNodes.forEach(n => n.classList.remove('selected-node'));
                node.classList.add('selected-node');
            }
        });
    });
});
