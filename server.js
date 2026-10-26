import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Eight reference photos at up to 5 MB each can exceed the old 20 MB limit.
app.use(express.json({ limit: '60mb' }));
app.use(express.static('public'));

const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

app.get('/api/health', (req, res) => {
  res.json({ ok: true, apiKeyConfigured: Boolean(ai) });
});

function parseImageData(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('Data foto master tidak valid.');
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/);
  if (!match) throw new Error('Format foto harus JPEG, PNG, atau WebP.');
  const base64 = match[2].replace(/\s/g, '');
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) throw new Error('Data foto tidak valid.');
  return { mimeType: match[1], data: base64 };
}

app.post('/api/generate-prompts', async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({ error: 'API Key belum diatur di file .env' });
    }

    const {
      concept,
      conceptDesc,
      resolution = '1080p',
      aspectRatio = '16:9',
      sceneCount = 3,
      sceneNumber,
      productName = '',
      dialogType = 'Menggunakan Narasi & Dialog',
      audioMode = 'Voice Over & ASMR',
      overlayLang = 'Bahasa Indonesia Gaul / Gen-Z',
      characterGroups = [],
      characterCount = 1
    } = req.body;

    const description = String(conceptDesc ?? concept ?? '').trim();
    if (!description) {
      return res.status(400).json({ error: 'Deskripsi konsep video wajib diisi.' });
    }

    const count = Number(sceneCount);
    const currentScene = sceneNumber == null ? null : Number(sceneNumber);
    const numCharacters = Number(characterCount);

    if (!Number.isInteger(count) || count < 1 || count > 10) {
      return res.status(400).json({ error: 'Jumlah scene harus antara 1 sampai 10.' });
    }
    if (currentScene !== null && (!Number.isInteger(currentScene) || currentScene < 1 || currentScene > count)) {
      return res.status(400).json({ error: 'Nomor scene tidak valid.' });
    }
    if (!Number.isInteger(numCharacters) || numCharacters < 1 || numCharacters > 8) {
      return res.status(400).json({ error: 'Jumlah karakter harus antara 1 sampai 8.' });
    }
    if (!Array.isArray(characterGroups)) {
      return res.status(400).json({ error: 'Kelompok karakter tidak valid.' });
    }

    const allImages = [];
    const characterDescriptions = [];
    for (let i = 0; i < Math.min(characterGroups.length, numCharacters); i++) {
      const group = characterGroups[i] || {};
      const name = String(group.name || `Karakter ${String.fromCharCode(65 + i)}`).slice(0, 100);
      const images = Array.isArray(group.images) ? group.images : [];
      characterDescriptions.push(`${name}: ${images.length ? `${images.length} foto referensi terlampir` : 'tidak memiliki foto referensi; rancang identitas visual yang jelas dari konsep dan pertahankan konsistensinya'}`);
      for (const imageData of images) {
        allImages.push({ characterName: name, data: parseImageData(imageData) });
      }
    }
    if (allImages.length > 8) {
      return res.status(400).json({ error: 'Maksimal 8 foto master untuk seluruh karakter.' });
    }

    const sceneInstruction = currentScene === null
      ? `Create prompts for all ${count} scenes.`
      : `Create prompts ONLY for scene ${currentScene} of ${count}.`;

    const parts = [{
      text: `You are STUDIO58, an expert prompt engineer for Google Flow image and video generation.
Create a polished affiliate/creative video prompt package using the requirements below.

VIDEO CONCEPT:
${description}

PRODUCT OR MAIN SUBJECT:
${productName || 'Use the main subject described in the concept.'}

CHARACTERS AND REFERENCE GROUPS:
Number of characters: ${numCharacters}
${characterDescriptions.join('\n')}
The attached images are grouped in order by character. Images for each group belong to that named character. Never transfer facial features, clothes, or identity from one character group to another.
${allImages.length ? 'Use the attached reference images as the highest-priority visual identity reference.' : 'No reference photos were provided. Invent appropriate character appearances based on the concept and write their appearance details explicitly in the image prompts.'}

OUTPUT SETTINGS:
Resolution target: ${resolution}
Aspect ratio: ${aspectRatio}
Total scenes: ${count}
Dialogue type: ${dialogType}
Audio mode: ${audioMode}
Text overlay language: ${overlayLang}

${sceneInstruction}

CRITICAL REQUIREMENTS:
- Respond in English for the prompts, but dialogue/voiceover and overlay text must use the selected language when relevant.
- Keep character identity consistent across every scene: face, age, skin tone, hairstyle, clothing, body shape, accessories, and distinguishing features. Repeat important identity details in each scene prompt.
- Maintain product packaging, label, proportions, logo placement, and colors when a product is shown.
- Make scenes visually distinct but keep continuity in narrative, wardrobe, environment, lighting, and style.
- Each image prompt must specify aspect ratio ${aspectRatio}, composition, subject appearance, environment, lighting, camera angle, visual style, and a useful negative prompt.
- Each video prompt must specify scene action, camera movement, timing/beat breakdown, transitions, sound effects, voiceover/dialogue if enabled, and overlay text if appropriate.
- Do not claim that a text prompt alone guarantees exact resolution.
- Avoid vague references such as "same character as before"; describe the identity consistently in each scene.
- Output only the two sections below, with no intro or extra commentary.

IMAGE PROMPT:
[Detailed standalone image-generation prompt for the requested scene. For a storyboard image, describe a clear sequence of keyframes/panels when useful.]

VIDEO PROMPT:
[Detailed standalone video-generation prompt including action, camera movement, timing, audio, narration/dialogue and overlay instructions.]`
    }];

    for (const item of allImages) {
      parts.push({ text: `Reference image for character group "${item.characterName}": use this image only for this character's identity.` });
      parts.push({ inlineData: item.data });
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [{ role: 'user', parts }]
    });
    const text = response.text || '';
    const imageMatch = text.match(/IMAGE PROMPT\s*:\s*([\s\S]*?)(?=\n\s*VIDEO PROMPT\s*:|$)/i);
    const videoMatch = text.match(/VIDEO PROMPT\s*:\s*([\s\S]*)$/i);

    if (!imageMatch || !videoMatch) {
      return res.json({
        imagePrompt: text || 'Gemini tidak mengembalikan prompt.',
        videoPrompt: 'Format hasil Gemini tidak terdeteksi. Coba generate ulang.',
        result: text
      });
    }

    res.json({
      imagePrompt: imageMatch[1].trim(),
      videoPrompt: videoMatch[1].trim(),
      result: text
    });
  } catch (error) {
    console.error('Gemini error:', error.message);
    const clientMessage = /foto|karakter|scene|konsep|format/i.test(error.message)
      ? error.message
      : 'Gagal membuat prompt. Periksa API Key di .env, koneksi internet, dan akses model Gemini.';
    res.status(500).json({ error: clientMessage });
  }
});

app.listen(port, () => {
  console.log(`STUDIO58 berjalan di http://localhost:${port}`);
});
