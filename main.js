const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { OpenAI } = require('openai');
const dotenv = require('dotenv');

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || '';

const INPUT_JSON = './content.json';
const OUTPUT_DIR = './output_reel';
// TEMP_DIR is deprecated in favor of dynamic per-content temp folders
let TEMP_DIR = null;
const VIDEO_WIDTH = 1080;
const VIDEO_HEIGHT = 1920;

async function generateSlideDetails(text, image_url, video_url) {
  const prompt = `You are an expert content creator making engaging short-form educational videos.

    Your task is to generate 4 to 6 engaging slides based on the content below.
    Each slide should include:
    - heading: A catchy, educational title (max 10 words)
    - description: A punchy one-liner to explain or tease the concept
    - imagePrompt: Descriptive, imaginative prompt for DALL-E 3
    - speakText: Engaging voiceover script for continuous storytelling (30-60 words)

    IMPORTANT:
    - All the contents will be in English.
    
    The slides should be concise and visual-rich to keep viewers engaged. The speakText should flow naturally from slide to slide, creating a cohesive narrative that hooks viewers and maintains their attention throughout the video.
    
    Input:
    Text: ${text || "N/A"}
    Image URL: ${image_url || "N/A"}
    Video URL: ${video_url || "N/A"}
    
    Respond with an array of 4–6 JSON slide objects.
    
    OUTPUT JSON FORMAT : 
    
    {
        "slides" : [
            {
                "heading": "Catchy Title",
                "description": "Engaging one-liner",
                "imagePrompt": "Detailed image prompt for DALL-E 3",
                "speakText": "Engaging voiceover content that flows naturally and tells a continuous story"
            },
            ...
        ]
    }
    
    `;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });

  console.log(response.choices[0].message);

  return JSON.parse(response.choices[0].message.content)["slides"];
}

async function generateImage(prompt, imagePath) {
  // const response = await openai.images.generate({
  //   model: 'dall-e-3',
  //   prompt,
  //   size: '1024x1792',
  //   quality: 'hd',
  //   response_format: 'url'
  // });
  // const url = response.data[0].url;
  // const res = await axios.get(url, { responseType: 'arraybuffer' });
  // await fs.writeFile(imagePath, res.data);

  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt: prompt,
    n: 1,
    size: '1024x1536',
    quality: "medium"
  });

  const imageBase64 = response.data[0].b64_json;
  const imageBuffer = Buffer.from(imageBase64, 'base64');
  fs.writeFileSync(imagePath, imageBuffer);
  return imagePath;
}

async function downloadImage(url, imagePath) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  await fs.writeFile(imagePath, res.data);
  return imagePath;
}

async function generateAudio(text, audioPath) {
  const response = await openai.audio.speech.create({
    model: 'tts-1-hd',
    voice: 'nova',
    input: text
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(audioPath, buffer);
  return audioPath;
}

async function generateAudioWithGoogle(text, audioPath) {
  const requestBody = {
    audioConfig: { audioEncoding: 'MP3', pitch: 0, speakingRate: 1 },
    input: { text: text.replace(/"/g, '') },
    voice: { languageCode: "en-IN", name: "en-IN-Wavenet-E" }
  };
  const response = await fetch(`https://us-central1-texttospeech.googleapis.com/v1beta1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    log(`Google TTS API error: ${response.status}`);
    throw new Error(`Google TTS API error: ${response.status}`);
  }

  const result = await response.json();
  const audioContent = Buffer.from(result.audioContent, 'base64');
  await fs.writeFile(audioPath, audioContent);
  return audioPath;
}

async function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

async function generateVideoSlide(imagePath, audioPath, videoPath) {
  const duration = await getAudioDuration(audioPath);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .loop(duration)
      .input(audioPath)
      .audioCodec('aac')
      .videoCodec('libx264')
      .size(`${VIDEO_WIDTH}x${VIDEO_HEIGHT}`)
      .outputOptions(['-pix_fmt yuv420p', '-shortest'])
      .save(videoPath)
      .on('end', () => resolve(videoPath))
      .on('error', reject);
  });
}

async function concatenateVideos(videoPaths, outputVideo, tempDir) {
  const fileListPath = path.join(tempDir, 'files.txt');
  const fileContent = videoPaths.map(p => `file '${path.resolve(p)}'`).join('\n');
  await fs.writeFile(fileListPath, fileContent + '', 'utf8'); // ensure file is flushed to disk
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(fileListPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .save(outputVideo)
      .on('end', resolve)
      .on('error', reject);
  });
}

async function main() {
  await fs.ensureDir(OUTPUT_DIR);

  let contentArray = JSON.parse(await fs.readFile(INPUT_JSON, 'utf-8'));
  let updated = false;

  for (let i = 0; i < contentArray.length; i++) {
    const item = contentArray[i];
    if (item.video_name) {
      console.log(`⏩ Skipping content ${i + 1}, video already generated.`);
      continue;
    }
    if (!item.text?.trim() && !item.image_url && !item.video_url) continue;

    const uniqueId = `content_${Date.now()}_${i}`;
    const tempDir = path.join(OUTPUT_DIR, 'temp_' + uniqueId);
    await fs.ensureDir(tempDir);

    console.log(`
▶ Slide ${i + 1}`);
    const slides = await generateSlideDetails(item.text, item.image_url, item.video_url);
    // const videoSlides = [];
    console.log(slides, slides.length);

    const videoSlides = await Promise.all(
      slides.map(async (slide, j) => {
        const imagePath = await generateImage(slide.imagePrompt, path.join(tempDir, `image_${j}.jpg`));

        const audioPath = await generateAudioWithGoogle(slide.speakText, path.join(tempDir, `audio_${j}.mp3`));
        return await generateVideoSlide(imagePath, audioPath, path.join(tempDir, `slide_${j}.mp4`));
      })
    );

    // for (let j = 0; j < slides.length; j++) {
    //   const slide = slides[j];
    //   const imagePath = await generateImage(slide.imagePrompt, path.join(tempDir, `image_${j}.jpg`));

    //   const audioPath = await generateAudio(slide.speakText, path.join(tempDir, `audio_${j}.mp3`));
    //   const videoPath = await generateVideoSlide(imagePath, audioPath, path.join(tempDir, `slide_${j}.mp4`));
    //   videoSlides.push(videoPath);
    // }

    const finalOutput = path.join(OUTPUT_DIR, `${uniqueId}.mp4`);
    await concatenateVideos(videoSlides, finalOutput, tempDir);
    console.log(`✅ Video created for content ${i + 1}: ${finalOutput}`);

    contentArray[i].video_name = path.basename(finalOutput);
    updated = true;
  }

  if (updated) {
    await fs.writeFile(INPUT_JSON, JSON.stringify(contentArray, null, 2));
    console.log('✅ content.json updated with generated video names.');
  }
}

main().catch(console.error);
