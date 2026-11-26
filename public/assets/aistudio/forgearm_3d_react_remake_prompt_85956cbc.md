# Master Build Prompt: ForgeArm 3D v2 (React + Three.js Parametric Weapon Forge)

Build **ForgeArm 3D v2**, a high-craft, 60 FPS interactive 3D Parametric Weapon Gunsmith and AI Co-Pilot web application in **React** (functional components + hooks, Tailwind CSS, `lucide-react`, and **Three.js** with `OrbitControls`, `RoomEnvironment`, and `GLTFExporter`).

The core philosophy: **the user has total, effortless creative control**—smoothly adding/removing/swapping high-detail components, sculpting proportions with smart constraints, hovering directly over 3D parts to inspect and select them, and painting with an intelligent multi-zone PBR material system—while an optional AI Co-Pilot assists with full builds or targeted tweaks without ever taking away manual control.

---

## 1. Visual Quality & Smooth Hard-Surface Geometry Standards

Eliminate blocky/low-poly artifacts. Every weapon part must look like a clean, game-ready CAD hard-surface asset:

- **Smooth Contours & Chamfers:** Use multi-segment bevels (`bevelSegments: 3`, `curveSegments: 8`) on extruded receivers, handguards, stocks, and mounts. Use `LatheGeometry` (24–32 radial segments) for turned barrels, fluted match chambers, suppressors, scope tubes/bells, turrets, and cylindrical drum magazines.
- **Spline-Swept Curved Magazines:** Never stack disjointed angled boxes for curved magazines. Build curved AK/STANAG magazines as a single smooth swept profile along a quadratic/cubic Bezier curve (or lofted cross-section mesh) with molded side reinforcement ribs and a flush rubberized floorplate.
- **Ergonomic Sculpting:** Pistol grips, cheekrests, and AK palm-swell handguards should feature smooth rounded cross-sections, finger grooves, and subtle bevel transitions rather than sharp rectangular slabs.
- **Tactile PBR Lighting & Rendering:**
  - `THREE.WebGLRenderer` with antialiasing, `ACESFilmicToneMapping`, soft PCF shadows (`2048x2048`), and `PMREMGenerator` + `RoomEnvironment` for crisp metallic specular highlights.
  - 3-point studio lighting (warm key light, cool rim light, subtle amber bounce fill) over a clean dark CAD studio floor with subtle radial fade grid.

---

## 2. Seamless, Unnoticeable Mechanical Joints (Smart Coupling System)

Parts must never appear floating, clipped awkwardly, or crudely stuck together. Implement a **Mechanical Collar & Socket Solver**:

- **Transitional Hardware at Every Seam:**
  - **Receiver ↔ Barrel / Handguard:** Add a machined barrel trunnion / barrel nut collar and front handguard retainer ferrule so the handguard hugs the receiver face seamlessly regardless of `receiverWidth`, `receiverHeight`, or `handguardBulk`.
  - **Receiver ↔ Stock:** Match the stock's front tang/trunnion flange to the receiver's rear cross-section width and hinge knuckle so solid, carbine, and folding stocks seat flush with zero gap.
  - **Receiver ↔ Magazine:** Extend a subtle recessed magwell collar around `attach_magwell` and tuck the magazine feed tower cleanly up inside the receiver cavity so rocking or scaling never reveals a hollow gap.
  - **Receiver ↔ Pistol Grip:** Add a contoured grip tang / beavertail adapter that blends smoothly into the underside of the receiver and frames the trigger guard cleanly across the entire `gripAngle` range.
  - **Rail Mount Clamps:** Every optic and underbarrel attachment includes a low-profile Picatinny clamp base that seats flush onto the top/bottom rail teeth.
- **Smart Automatic Mechanical Constraints:**
  - **Handguard-to-Barrel Guardrail:** Automatically clamp effective handguard length so it never extends past the barrel tip (leaving clearance for muzzle threads).
  - **True Bullpup Architecture:** Selecting the `Bullpup` receiver automatically relocates `attach_magwell` behind the pistol grip (`+Z`), moves `bone_bolt` to the rear/mid chassis, shifts the pistol grip forward to preserve `(0, 0, 0)` hand origin, and pairs cleanly with compact rear buttpads.
  - **Smart Underbarrel & Handguard Coupling:** If the user removes the handguard (`none`), gracefully hide or disable incompatible underbarrel mounts and return `socket_hand_l` to a safe barrel-support position; when a vertical/angled grip or launcher is equipped, automatically move `socket_hand_l` onto the grip handle.
  - **Canonical Game-Engine Rig Alignment:** World origin `(0, 0, 0)` is locked to the pistol grip hand center, barrel points strictly along `-Z`, up is `+Y`.

---

## 3. High-Quality Modular Component Library (9 Slots)

Support Add / Remove (`none` where optional) and instant Swap across all 9 slots:

1. **Receiver (Core):**
   - `ak_stamped` — Classic AK-47 stamped receiver, ribbed sloped dust cover, rear sight leaf block, side dovetail rail, side selector lever.
   - `ak12_modern` — Modernized railed dust cover, flared magwell, streamlined receiver contours.
   - `ar_flattop` — Forged upper/lower AR-15, brass deflector, forward assist, flared magwell, continuous top Picatinny rail.
   - `bullpup` — Monolithic bullpup hull with rear `+Z` magwell, elevated cheekrest, full top rail bridge.
   - `scifi_rail` — Chamfered composite chassis with recessed emissive energy vents and reinforced frame ribs.
2. **Barrel (Core):**
   - `ak_gastube` — Turned barrel, upper gas tube, angled gas block, cleaning rod, hooded AK front sight post.
   - `heavy_sniper` — Thick match-grade fluted barrel with stepped chamber collar.
   - `compact_smg` — Short CQB barrel with perforated heat collar.
   - `integral_suppressed` — AS-VAL / Honey Badger style integrated shrouded silencer barrel.
   - `twin_scifi` — Over-under twin barrels with stabilizer clamps and glowing central rail core.
3. **Handguard (Optional — includes `none`):**
   - `ak_wood` — Classic contoured upper & lower wooden palm-swell forend with steel ferrules.
   - `tactical_mlok` — Slim octagonal free-float rail with recessed M-LOK vent slots and top/bottom rail sections.
   - `quad_rail` — Classic tactical 4-sided Picatinny forend with rail covers.
   - `compact_shroud` — Ergonomic CQB forend with integrated front handstop lip.
   - `scifi_angled` — Tapered armored cowling with side cooling louvers and subtle emissive strips.
4. **Stock (Optional — includes `none` for Draco/pistol mode):**
   - `ak_wood` — Smoothly contoured angled wooden buttstock with curved steel buttplate and sling loop.
   - `tactical_carbine` — Buffer tube with ribbed locking nut, angled Crane stock body, and textured rubber recoil pad.
   - `skeleton_folder` — AKS-74U triangular strut folding stock with hinge knuckle.
   - `precision_sniper` — Heavy adjustable stock with elevated cheek riser and monopod cut.
   - `bullpup_buttpad` — Compact ergonomic rubberized rear buttpad.
5. **Magazine (Optional — includes `none`):**
   - `ak_curved` — Smoothly curved 30rd ribbed banana mag with baseplate.
   - `ak_bakelite` — Smooth sleek curved polymer/bakelite AK mag.
   - `ar_stanag` — Slightly curved tactical PMAG-style magazine with textured grip ribs and ammo window.
   - `smg_stick` — Slim vertical pistol-caliber stick mag.
   - `drum_mag` — 75rd cylindrical drum with feed tower, concentric ribs, and winding key.
   - `scifi_cell` — Heavy futuristic battery cartridge with emissive charge indicator bars.
6. **Pistol Grip (Core):**
   - `ak_slanted` — Rounded classic AK grip with top ferrule and subtle diamond checkering.
   - `tactical_ergo` — Contoured grip with beavertail palm swell and finger grooves.
   - `cqb_vertical` — Steep modern competition grip with flared mag-base lip.
   - `precision_palm` — Sniper grip with adjustable bottom palm shelf.
7. **Muzzle (Optional — includes `none`):**
   - `slant_brake` — Classic angled AK recoil compensator.
   - `suppressor` — Turned tactical silencer with QD knurled collar, expansion ribs, and recessed bore.
   - `tank_brake` — Heavy dual-baffle sniper muzzle brake.
   - `flash_hider` — 4-prong slotted birdcage flash hider.
   - `linear_comp` — Sleek fluted blast forwarder.
8. **Optic (Optional — includes `none`):**
   - `iron_sights` — Low-profile flip-up rear peep sight with protective wings.
   - `red_dot` — Armored EOTech-style holographic sight with tinted glass reflex window.
   - `micro_reflex` — Compact open-frame RMR/dot sight on skeletonized riser.
   - `acog` — 4x prism combat optic with glowing top fiber-optic tube and tinted objective/eyepiece lenses.
   - `sniper_scope` — Precision variable scope with dual machined rings, flared objective bell, elevation/windage turrets, sunshade, and coated lenses.
9. **Underbarrel (Optional — includes `none`):**
   - `vertical_grip` — Turned ergonomic tactical foregrip with textured rubber cap.
   - `angled_grip` — Sleek contoured AFG thumb-break grip.
   - `grenade_launcher` — Underslung 40mm launcher with ribbed barrel tube, quadrant mount, and rear trigger block.
   - `tactical_laser` — Compact PEQ emitter housing with dual lenses and laser glow dot.
   - `bipod` — Stowed/deployed dual-leg precision sniper bipod.

---

## 4. Interactive 3D Hover Selection & Viewport UX

Make interacting directly with the 3D weapon feel effortless and responsive:

- **3D Hover-to-Highlight:**
  - Raycast on `pointermove` across weapon meshes (skip while actively orbiting/panning the camera).
  - Highlight the hovered component cleanly with a smooth, subtle emissive tint (distinct from the active-selected state) and switch cursor to `pointer`.
  - Show a crisp floating cursor tooltip near the mouse: **Component Name + Equipped Variant** (e.g., `Handguard • Tactical M-LOK — Click to edit`).
  - **Bidirectional Sync:** Hovering a component pill in the UI also gently highlights that exact 3D component in the viewport!
- **Click-to-Select & Camera Focus:**
  - Clicking any 3D component selects it immediately with a brief amber confirmation pulse and opens its controls in the inspector.
  - Include a subtle **"Focus Part"** button (or double-click on a 3D part) that smoothly interpolates `OrbitControls.target` to inspect that part up close, plus a **Reset View** button.

---

## 5. Clean, Organized, Simple UI Layout

Avoid overwhelming walls of 9 stacked cards and 16 sliders at once. Design a calm, modern, focused studio interface:

- **Full-Bleed 3D Viewport (~70–75% of screen):** Gives the weapon center stage.
- **Minimal Floating Top Bar:**
  - Left: Compact **ForgeArm 3D** badge + Undo / Redo buttons.
  - Center: Sleek single-line **AI Co-Pilot** prompt input (`"make it a short suppressed AK with worn walnut wood"`) + subtle dropdown/pills for 4 instant starter presets.
  - Right: Primary **Export .GLB** CTA button + compact menu for `Save JSON` / `Load JSON`.
- **Clean Component Selector Rail (Bottom-Left or Top of Inspector):**
  - 9 compact, scannable pills showing each slot's name, active paint color dot, and dimmed/off indicator if removed (`none`). Hovering highlights the 3D part; clicking focuses the Inspector on **that single component**.
- **Focused Right Inspector Panel (~340–360px, uncluttered):**
  - Header showing the currently selected component (e.g. **Magazine — AK Ribbed Banana**) with a quick **Remove / Equip** toggle for optional slots and a **Focus Camera** icon button.
  - Only **2 simple tabs** for the active component (plus a quick **Themes** button):
    1. **Build & Shape:**
       - Clean 2-column grid of part variants for *only* the active component.
       - Right below it, *only* the 1–3 parametric shape sliders relevant to that active component (e.g., `Length` and `Curve` when Magazine is selected; `Length` and `Thickness` when Barrel is selected), with a 1-click reset icon per slider.
    2. **Smart Paint:**
       - Focused paint controls for the active component + 1-click Smart Group Sync buttons (described below).
- **Compact Bottom-Center Viewport Pill:**
  - Clean icon+label controls: `Fire`, `Reload`, `Fold Stock`, `Rig Overlay`, `Wireframe`, `Reset Cam`, plus a subtle live telemetry badge (`TRIS | PARTS | CM`).

---

## 6. Smart Painting & PBR Material System

Upgrade painting from basic flat color pickers to an intuitive, high-detail smart material studio:

- **Smart Group Sync (No Repetitive Clicking):**
  - User can paint just the **Active Component**, OR apply the current finish with one click to smart mechanical groups:
    - **This Part Only**
    - **All Metal Parts** (Receiver, Barrel, Muzzle, Optic)
    - **All Furniture** (Handguard, Stock, Pistol Grip)
    - **All Attachments** (Magazine, Optic, Underbarrel, Muzzle)
    - **Whole Weapon**
- **Dual-Tone Primary + Secondary Color:**
  - Every component supports a **Primary Color** and an optional **Accent / Secondary Color** (automatically harmonized when switching primary, or manually editable) that drives camo secondary tones, wood grain depth, carbon weave contrast, or worn metal undertones.
- **512×512 Procedural PBR Maps (Diffuse + Bump + Roughness):**
  - Generate crisp, cached offscreen `CanvasTexture` albedo maps paired with matching procedural **bumpMap** and **roughnessMap** so materials feel genuinely physical under studio light (and embed cleanly in `.GLB` export):
    - `Solid Coat` (smooth anodized/cerakote)
    - `Varnished Wood` (organic grain streaks, knots, satin clearcoat roughness)
    - `Carbon Fiber` (tight diagonal 2x2 twill weave with specular shimmer)
    - `Digital Camo` (multi-tone crisp tactical pixel camo)
    - `Tiger Stripe` (organic brushed camouflage bands)
    - `Hex Tech` (precision futuristic hex grid)
    - `Brushed Steel` (directional machined metal striations)
- **Live Surface Controls:**
  - Quick Material Finish chips (`Blued Steel`, `Matte Polymer`, `Varnished Wood`, `Titanium`, `Polished Gold`, `Tactile Rubber`, `Carbon`).
  - Sliders for **Metalness**, **Roughness**, **Pattern Scale** (`0.5x – 3.0x`), and **Battle Wear / Edge Scuffs** (`0% – 100%`, dynamically layering edge scratches and carbon grime onto the texture).
- **Curated Full-Weapon Smart Themes:**
  - 6 cohesive one-click full-weapon paint themes (`Classic Soviet AK`, `Spec-Ops Matte`, `Desert Operator FDE`, `OD Woodland`, `Arctic Winter`, `Cyber Titanium & Gold`).

---

## 7. Live Rig Testing, Animation & Game-Ready .GLB Export

- **Hierarchical glTF 2.0 Scene Graph (`root_weapon`):**
  - `root_weapon` at `(0, 0, 0)` (pistol grip hand center) → `body_receiver` → named animatable rig nodes (`bone_bolt`, `bone_trigger`, `bone_selector`, `bone_stock`, `bone_magazine`) + empty marker sockets (`socket_muzzle`, `socket_hand_l`).
- **Interactive Rig Tests:**
  - **Fire:** Snappy bolt carrier blowback, trigger hinge pull, and additive muzzle flash + point light spawned at `socket_muzzle` (kept outside `root_weapon` so VFX never pollute exports).
  - **Test Reload:** Realistic rock-and-lock detach/re-insert animation on `bone_magazine` followed by a bolt rack.
  - **Fold Stock:** Smooth 165° side-fold around the left trunnion hinge `bone_stock`.
  - **Rig & Sockets Overlay:** Toggles 3D gizmos and projected 2D monospace callout labels (`root_weapon`, `bone_*`, `socket_*`).
- **Clean `.GLB` Export:**
  - Temporarily snaps all rig bones back to neutral bind pose, strips hover/selection emissive highlights and wireframe state, exports `root_weapon` via `GLTFExporter` (`binary: true, trs: true`), and restores viewport state—producing a clean `.glb` ready for Godot, Unity, or Blender.

---

## 8. Smart AI Gunsmith Co-Pilot (Context-Aware Edits)

- Powered by `gemini-3-flash-preview` using structured JSON output (`responseMimeType: "application/json"` with `responseSchema`) plus exponential backoff and a smart offline keyword fallback.
- **Context-Aware Partial Editing:** Send the weapon's *current* JSON state alongside the user's prompt so the AI supports both:
  - **Full builds:** *"Build a compact suppressed bullpup in OD green"*
  - **Targeted edits without wiping user work:** *"Keep my parts, just paint it battle-worn desert camo and add a red dot"* or *"Swap the magazine to a 75rd drum and make the barrel longer"*.
- Include an **Undo / Redo** history stack (up to 25 steps) so users can safely experiment with AI suggestions, randomization, or manual tweaks.

---

## 9. React Technical Architecture & Performance Rules

- **Imperative 3D Engine + Reactive UI Split:**
  - Encapsulate the Three.js scene, procedural geometry builders, raycaster, texture cache, and animation loop in a dedicated imperative controller class/hook mounted via `useRef`, completely decoupled from React's render tree.
  - Dragging shape or paint sliders updates Three.js at 60 FPS with zero jank (paint changes mutate materials in place without rebuilding geometry; shape changes dispose old geometries cleanly to prevent WebGL memory leaks).
- **Strict Cleanup & Stability:**
  - Proper `ResizeObserver` viewport sizing, `dispose()` on geometries/materials/textures on unmount and rebuild, error boundary around the 3D canvas, no `alert()` or `confirm()` (use sleek non-blocking toast notifications), and full mobile + desktop responsiveness.