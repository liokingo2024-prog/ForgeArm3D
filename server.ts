import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const GUNSMITH_SYSTEM_INSTRUCTION = `You are ForgeArm 3D AI Gunsmith Co-Pilot.
You receive the user's natural-language design request and the weapon's CURRENT JSON configuration.
Return a JSON object containing:
- "summary": concise 4-10 word description of changes applied
- "config": the updated WeaponConfig JSON matching the schema.

CRITICAL RULES:
1. Context-aware editing: If the user asks for a targeted tweak ("keep my parts", "swap mag to drum", "paint it desert camo", "make barrel longer", "add a red dot"), preserve all unmentioned parts, dimensions, and paints from currentConfig!
2. Full build: If the user requests a completely new weapon build ("build a compact suppressed bullpup in OD green"), update parts, dimensions, and paints cohesively.
3. Only use exact allowed enum strings:
   - receiver: ak_stamped | ak12_modern | ar_flattop | scar_monolithic | smg_mp5 | bolt_chassis | bullpup | scifi_rail
   - barrel: ak_gastube | heavy_sniper | compact_smg | carbon_wrapped | finned_lmg | integral_suppressed | twin_scifi
   - handguard: none | ak_wood | tactical_mlok | quad_rail | keymod_slim | heatshield_perforated | compact_shroud | scifi_angled
   - stock: none | ak_wood | tactical_carbine | skeleton_folder | precision_sniper | scar_boot | pdw_wire | thumbhole_sport | bullpup_buttpad
   - magazine: none | ak_curved | ak_bakelite | ar_stanag | coupled_dual | box_sniper | smg_stick | drum_mag | scifi_cell
   - grip: ak_slanted | tactical_ergo | rubber_overmold | skeleton_cnc | cqb_vertical | angled_pdw | precision_palm
   - muzzle: none | slant_brake | suppressor | osp_rectangular | tank_brake | flash_hider | linear_comp | breacher_spike
   - optic: none | iron_sights | red_dot | micro_reflex | acog | lpvo_tactical | sniper_scope | thermal_holo
   - underbarrel: none | vertical_grip | angled_grip | handstop_kit | tactical_light | tactical_laser | bipod | grenade_launcher | masterkey_shotgun
   - pattern: solid | wood | carbon | digital_camo | tiger_stripe | hex_tech | brushed_steel
4. Colors must be 6-digit hex strings like "#2b3138". Keep dimensions within realistic bounds.`;

const partPaintSchema = {
  type: Type.OBJECT,
  properties: {
    primaryColor: { type: Type.STRING },
    secondaryColor: { type: Type.STRING },
    pattern: { type: Type.STRING },
    metalness: { type: Type.NUMBER },
    roughness: { type: Type.NUMBER },
    patternScale: { type: Type.NUMBER },
    wear: { type: Type.NUMBER },
  },
};

const gunsmithResponseSchema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    config: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        parts: {
          type: Type.OBJECT,
          properties: {
            receiver: { type: Type.STRING },
            barrel: { type: Type.STRING },
            handguard: { type: Type.STRING },
            stock: { type: Type.STRING },
            magazine: { type: Type.STRING },
            grip: { type: Type.STRING },
            muzzle: { type: Type.STRING },
            optic: { type: Type.STRING },
            underbarrel: { type: Type.STRING },
          },
        },
        dimensions: {
          type: Type.OBJECT,
          properties: {
            receiverLength: { type: Type.NUMBER },
            receiverHeight: { type: Type.NUMBER },
            receiverWidth: { type: Type.NUMBER },
            receiverRailHeight: { type: Type.NUMBER },
            barrelLength: { type: Type.NUMBER },
            barrelThickness: { type: Type.NUMBER },
            barrelOffsetY: { type: Type.NUMBER },
            handguardLength: { type: Type.NUMBER },
            handguardBulk: { type: Type.NUMBER },
            handguardHeight: { type: Type.NUMBER },
            handguardOffset: { type: Type.NUMBER },
            stockLength: { type: Type.NUMBER },
            stockWidth: { type: Type.NUMBER },
            stockDrop: { type: Type.NUMBER },
            stockButtHeight: { type: Type.NUMBER },
            stockCheekHeight: { type: Type.NUMBER },
            magLength: { type: Type.NUMBER },
            magCurve: { type: Type.NUMBER },
            magWidth: { type: Type.NUMBER },
            magAngle: { type: Type.NUMBER },
            gripLength: { type: Type.NUMBER },
            gripAngle: { type: Type.NUMBER },
            gripThickness: { type: Type.NUMBER },
            muzzleScale: { type: Type.NUMBER },
            muzzleLengthScale: { type: Type.NUMBER },
            muzzleDiameterScale: { type: Type.NUMBER },
            opticOffset: { type: Type.NUMBER },
            opticScale: { type: Type.NUMBER },
            opticMountHeight: { type: Type.NUMBER },
            opticLensScale: { type: Type.NUMBER },
            underbarrelOffset: { type: Type.NUMBER },
            underbarrelScale: { type: Type.NUMBER },
            underbarrelWidth: { type: Type.NUMBER },
            underbarrelDrop: { type: Type.NUMBER },
          },
        },
        paints: {
          type: Type.OBJECT,
          properties: {
            receiver: partPaintSchema,
            barrel: partPaintSchema,
            handguard: partPaintSchema,
            stock: partPaintSchema,
            magazine: partPaintSchema,
            grip: partPaintSchema,
            muzzle: partPaintSchema,
            optic: partPaintSchema,
            underbarrel: partPaintSchema,
          },
        },
      },
    },
  },
};

async function callGeminiWithBackoff(prompt: string, currentConfig: unknown) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    const err = new Error('GEMINI_API_KEY is not configured on the server.');
    (err as Error & { status?: number }).status = 503;
    throw err;
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `User request: "${prompt}"\n\nCurrent weapon JSON:\n${JSON.stringify(currentConfig)}`,
        config: {
          systemInstruction: GUNSMITH_SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseSchema: gunsmithResponseSchema,
        },
      });
      const text = (response.text ?? '').trim();
      if (!text) throw new Error('Empty response from Gemini model.');
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 400 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/api/ai-gunsmith', async (req, res) => {
    const { prompt, currentConfig } = req.body ?? {};
    if (typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'Prompt is required.' });
      return;
    }

    try {
      const parsed = await callGeminiWithBackoff(prompt.trim(), currentConfig ?? {});
      res.json({
        source: 'gemini',
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'AI build updated',
        config: parsed.config ?? {},
      });
    } catch (err) {
      const status = (err as Error & { status?: number })?.status ?? 502;
      const message = err instanceof Error ? err.message : 'Gemini request failed.';
      res.status(status).json({ error: message });
    }
  });

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ForgeArm 3D server running on http://localhost:${PORT}`);
  });
}

startServer();
