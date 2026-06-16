
document.addEventListener('DOMContentLoaded', () => {
    const petContainer = document.getElementById('companionPet');
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;

    // Interactive Drag Mechanics
    petContainer.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);

    function dragStart(e) {
        initialX = e.clientX - xOffset;
        initialY = e.clientY - yOffset;
        if (e.target === petContainer || petContainer.contains(e.target)) {
            isDragging = true;
        }
    }

    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            xOffset = currentX;
            yOffset = currentY;
            petContainer.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
        }
    }

    function dragEnd() {
        isDragging = false;
    }

    // Spark micro-action trigger on simple clicking
    petContainer.addEventListener('click', () => {
        const bubble = petContainer.querySelector('.pet-speech-bubble');
        bubble.textContent = "⚡ Sparky! Continuous build loop stable.";
        
        // Micro scale burst feedback effect
        petContainer.style.transform = `${petContainer.style.transform} scale(1.1)`;
        setTimeout(() => {
            petContainer.style.transform = petContainer.style.transform.replace(' scale(1.1)', '');
        }, 150);
    });
});
