#!/bin/bash

# Configuration
PET_NAME="pica"
RUN_DIR="/home/nishanth/openbrain/openbrainpet-run/${PET_NAME}"
CHROMA="#FF00FF"

mkdir -p "${RUN_DIR}"
mkdir -p "${RUN_DIR}/cells"
mkdir -p "/home/nishanth/openbrain/openbrain/pica"

# Write pet.json manifest out to the pica asset directory
cat << 'MANIFEST_EOF' > "/home/nishanth/openbrain/openbrain/pica/pet.json"
{
  "id": "pica",
  "displayName": "Pica",
  "description": "A loyal, electric-yellow chibi rodent companion that sparks up when your builds pass and bobs happily while you refactor.",
  "spritesheetPath": "spritesheet.webp"
}
MANIFEST_EOF

echo "⚡ Step 1: Generating the canonical chibi Pica pose on RunComfy..."
SOURCE_URL="https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=500"

runcomfy run openai/gpt-image-2/edit \
  --input "{
    \"prompt\": \"Generate one canonical digital pet sprite based on the yellow electric rodent theme. EXAGGERATED chibi proportions: the head occupies about 60 percent of the total figure height; body and legs are tiny, stubby, and short. Electric yellow fur, long pointed ears with black tips, rosy red circular cheeks, and a lightning bolt-shaped tail. The whole pet figure must fit within a near-square bounding box (overall aspect close to 1:1). Pixel-art-adjacent low-resolution mascot, chunky whole-body silhouette, thick dark 2px outline, visible stepped pixel edges, limited palette, flat cel shading, simple expressive face, tiny limbs. Centered in the image. Background: solid flat magenta ${CHROMA} chroma-key fill outside the pet silhouette.\",
    \"images\": [\"${SOURCE_URL}\"],
    \"size\": \"1024*1024\"
  }" \
  --output-dir "${RUN_DIR}/decoded/"

BASE=$(ls "${RUN_DIR}/decoded/"*.png | head -1)
if [ -z "$BASE" ]; then
    echo "❌ Error: Generation failed or file not found."
    exit 1
fi

echo "✂️ Step 2: Normalizing into standard 192x208 canvas..."
magick "${BASE}" \
  -fuzz 18% -transparent "${CHROMA}" \
  -alpha set \
  -trim +repage \
  -resize 192x208 \
  -gravity center \
  -background none \
  -extent 192x208 \
  "${RUN_DIR}/cell.png"

echo "🎬 Step 3: Compiling 9-row animation matrices..."
SRC="${RUN_DIR}/cell.png"

# Basic layout generation mirroring standard sheets
magick "${SRC}" -duplicate 7 +append "${RUN_DIR}/row.png"
magick "${RUN_DIR}/row.png" -duplicate 8 -append "/home/nishanth/openbrain/openbrain/pica/spritesheet.webp"

echo "✨ Success! Pica configuration files compiled under ./openbrain/pica/"
