document.addEventListener('DOMContentLoaded', () => {

    // --- 1. Gallery Filtering Feature ---
    const filterButtons = document.querySelectorAll('.filter-btn');
    const flowerCards = document.querySelectorAll('.flower-card');

    filterButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Remove active status from all options
            filterButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            const filterValue = button.getAttribute('data-filter');

            flowerCards.forEach(card => {
                const category = card.getAttribute('data-category');
                
                if (filterValue === 'all' || category === filterValue) {
                    card.style.display = 'block';
                    // Quick fade in simulation
                    card.style.opacity = '1';
                } else {
                    card.style.display = 'none';
                    card.style.opacity = '0';
                }
            });
        });
    });

    // --- 2. Live Add To Basket Counter Simulation ---
    let basketItemCount = 0;
    const cartCountBadge = document.getElementById('cartCount');
    const addToCartButtons = document.querySelectorAll('.add-to-cart-btn');

    addToCartButtons.forEach(button => {
        button.addEventListener('click', () => {
            basketItemCount++;
            cartCountBadge.textContent = basketItemCount;
            
            // Add a subtle bounce animation effect on click
            button.style.transform = 'scale(0.95)';
            setTimeout(() => {
                button.style.transform = 'scale(1)';
            }, 100);
        });
    });

    // --- 3. Clean Contact Form Submission Notice ---
    const contactForm = document.getElementById('contactForm');
    
    contactForm.addEventListener('submit', (e) => {
        e.preventDefault(); // Stop standard page refreshing behavior
        
        const nameInput = document.getElementById('name').value;
        
        // Popup a lovely confirmation alerts box 
        alert(`Thank you for reaching out, ${nameInput}! Our chief florist will contact you shortly regarding your arrangement.`);
        
        contactForm.reset();
    });
});
