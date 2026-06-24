import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  type VideoSample
} from 'mediabunny';
import type { AssetRecord, ProjectRecord, TextStyleRecord, TimelineItem } from './types';

type ExportOptions = { onProgress(progress: number): void };

type VideoClipReader = {
  iterator?: AsyncGenerator<VideoSample | null, void, unknown>;
  sink?: VideoSampleSink;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function trackIndex(project: ProjectRecord, clip: TimelineItem) {
  const index = project.tracks.findIndex((track) => track.id === clip.trackId);
  return index < 0 ? project.tracks.length : index;
}

function trackFor(project: ProjectRecord, clip: TimelineItem) {
  return project.tracks.find((track) => track.id === clip.trackId);
}

function transitionState(clip: TimelineItem, time: number) {
  const transition = clip.transition || { type: 'none', duration: 0.5 };
  if (transition.type === 'none') return { opacity: 1, x: 0 };
  const progress = clamp((time - clip.start) / Math.max(0.05, Math.min(clip.duration, transition.duration)), 0, 1);
  return {
    opacity: transition.type === 'fade' || transition.type === 'dissolve' ? progress : 1,
    x: transition.type === 'slide' ? (1 - progress) * 0.24 : 0
  };
}

function drawMedia(
  context: CanvasRenderingContext2D,
  project: ProjectRecord,
  clip: TimelineItem,
  time: number,
  sourceWidth: number,
  sourceHeight: number,
  draw: (sx: number, sy: number, sourceWidth: number, sourceHeight: number, x: number, y: number, width: number, height: number) => void
) {
  const transform = clip.transform;
  let sx = sourceWidth * transform.cropX / 100;
  let sy = sourceHeight * transform.cropY / 100;
  let croppedWidth = Math.max(1, sourceWidth * transform.cropWidth / 100);
  let croppedHeight = Math.max(1, sourceHeight * transform.cropHeight / 100);
  croppedWidth = Math.min(croppedWidth, sourceWidth - sx);
  croppedHeight = Math.min(croppedHeight, sourceHeight - sy);
  const projectRatio = project.width / project.height;
  let sourceRatio = croppedWidth / croppedHeight;
  let width: number;
  let height: number;
  if (transform.fit === 'cover') {
    if (sourceRatio > projectRatio) {
      const nextWidth = croppedHeight * projectRatio;
      sx += (croppedWidth - nextWidth) / 2;
      croppedWidth = nextWidth;
    } else if (sourceRatio < projectRatio) {
      const nextHeight = croppedWidth / projectRatio;
      sy += (croppedHeight - nextHeight) / 2;
      croppedHeight = nextHeight;
    }
    width = project.width;
    height = project.height;
  } else {
    sourceRatio = croppedWidth / croppedHeight;
    width = sourceRatio >= projectRatio ? project.width : project.height * sourceRatio;
    height = sourceRatio >= projectRatio ? project.width / sourceRatio : project.height;
  }
  const transition = transitionState(clip, time);
  context.save();
  context.globalAlpha = (transform.opacity / 100) * transition.opacity;
  context.translate(
    project.width * (0.5 + transform.x / 100) + transition.x * project.width,
    project.height * (0.5 + transform.y / 100)
  );
  context.rotate((transform.rotation * Math.PI) / 180);
  context.scale(transform.scale * (transform.flipX ? -1 : 1), transform.scale * (transform.flipY ? -1 : 1));
  draw(sx, sy, croppedWidth, croppedHeight, -width / 2, -height / 2, width, height);
  context.restore();
}

function rgba(color: string, alpha: number) {
  const hex = color.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return color;
  const value = Number.parseInt(hex, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${clamp(alpha, 0, 1)})`;
}

function drawText(context: CanvasRenderingContext2D, project: ProjectRecord, clip: TimelineItem, time: number) {
  const style: TextStyleRecord = clip.textStyle || {
    fontFamily: 'DM Sans', fontSize: 64, color: '#ffffff', align: 'center',
    backgroundColor: '#000000', backgroundOpacity: 0, animation: 'none'
  };
  const localProgress = clamp((time - clip.start) / Math.max(0.15, Math.min(0.7, clip.duration)), 0, 1);
  const transition = transitionState(clip, time);
  const text = style.animation === 'typewriter'
    ? (clip.text || '').slice(0, Math.ceil((clip.text || '').length * localProgress))
    : clip.text || '';
  const fontSize = Math.max(10, style.fontSize * project.width / 1920);
  context.save();
  context.globalAlpha = (clip.transform.opacity / 100) * transition.opacity * (style.animation === 'fade' ? localProgress : 1);
  context.translate(
    project.width * (0.5 + clip.transform.x / 100) + transition.x * project.width,
    project.height * (0.5 + clip.transform.y / 100) + (style.animation === 'slide-up' ? (1 - localProgress) * project.height * 0.2 : 0)
  );
  context.rotate((clip.transform.rotation * Math.PI) / 180);
  context.scale(clip.transform.scale, clip.transform.scale);
  context.font = `700 ${fontSize}px "${style.fontFamily}", sans-serif`;
  context.textAlign = style.align;
  context.textBaseline = 'middle';
  const metrics = context.measureText(text);
  const textWidth = Math.min(project.width * 0.9, metrics.width);
  const anchorX = style.align === 'left' ? -textWidth / 2 : style.align === 'right' ? textWidth / 2 : 0;
  if (style.backgroundOpacity > 0) {
    context.fillStyle = rgba(style.backgroundColor, style.backgroundOpacity / 100);
    context.fillRect(-textWidth / 2 - fontSize * 0.25, -fontSize * 0.72, textWidth + fontSize * 0.5, fontSize * 1.44);
  }
  context.fillStyle = style.color;
  context.fillText(text, anchorX, 0, project.width * 0.9);
  context.restore();
}

export async function renderProjectPreview(project: ProjectRecord, time = 0): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = Math.max(2, Math.round(canvas.width * project.height / project.width));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('No se pudo generar la preview del proyecto.');

  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const inputs = new Map<string, Input<BlobSource>>();
  const getBlob = async (asset: AssetRecord) => {
    if (!asset.objectUrl) throw new Error(`No se puede cargar ${asset.name}.`);
    const response = await fetch(asset.objectUrl);
    if (!response.ok) throw new Error(`No se puede leer ${asset.name}.`);
    return response.blob();
  };
  const getInput = async (asset: AssetRecord) => {
    let input = inputs.get(asset.id);
    if (!input) {
      input = new Input({ source: new BlobSource(await getBlob(asset)), formats: ALL_FORMATS });
      inputs.set(asset.id, input);
    }
    return input;
  };
  const clips = project.timeline
    .filter((clip) => (clip.type === 'video' || clip.type === 'image' || clip.type === 'text')
      && time >= clip.start && time < clip.start + clip.duration
      && !trackFor(project, clip)?.hidden)
    .sort((a, b) => trackIndex(project, b) - trackIndex(project, a));

  context.setTransform(canvas.width / project.width, 0, 0, canvas.height / project.height, 0, 0);
  context.fillStyle = '#000000';
  context.fillRect(0, 0, project.width, project.height);
  try {
    for (const clip of clips) {
      if (clip.type === 'text') {
        drawText(context, project, clip, time);
        continue;
      }
      const asset = clip.assetId ? assets.get(clip.assetId) : undefined;
      if (!asset) continue;
      if (clip.type === 'image') {
        const image = await createImageBitmap(await getBlob(asset));
        drawMedia(context, project, clip, time, image.width, image.height, (sx, sy, sw, sh, x, y, width, height) => context.drawImage(image, sx, sy, sw, sh, x, y, width, height));
        image.close();
        continue;
      }
      const input = await getInput(asset);
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) continue;
      const rate = clip.playbackRate || 1;
      const sourceTime = (clip.trimStart || 0) + (clip.reverse ? Math.max(0, clip.duration * rate - 1 / project.fps) : 0);
      const sample = await new VideoSampleSink(track).getSample(sourceTime);
      if (!sample) continue;
      drawMedia(context, project, clip, time, sample.displayWidth, sample.displayHeight, (sx, sy, sw, sh, x, y, width, height) => sample.draw(context, sx, sy, sw, sh, x, y, width, height));
      sample.close();
    }
    return canvas.toDataURL('image/jpeg', 0.78);
  } finally {
    inputs.forEach((input) => input.dispose());
  }
}

function reverseAudioSlice(context: OfflineAudioContext, source: AudioBuffer, offset: number, duration: number) {
  const start = Math.max(0, Math.floor(offset * source.sampleRate));
  const length = Math.max(1, Math.min(source.length - start, Math.floor(duration * source.sampleRate)));
  const reversed = context.createBuffer(source.numberOfChannels, length, source.sampleRate);
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const input = source.getChannelData(channel);
    const output = reversed.getChannelData(channel);
    for (let index = 0; index < length; index += 1) output[index] = input[start + length - index - 1];
  }
  return reversed;
}

export async function renderProjectToMp4(project: ProjectRecord, options: ExportOptions): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(project.width / 2) * 2);
  canvas.height = Math.max(2, Math.round(project.height / 2) * 2);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('No se pudo iniciar el compositor de video.');

  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const blobCache = new Map<string, Promise<Blob>>();
  const inputCache = new Map<string, Input<BlobSource>>();
  const imageCache = new Map<string, ImageBitmap>();
  const getBlob = (asset: AssetRecord) => {
    let promise = blobCache.get(asset.id);
    if (!promise) {
      if (!asset.objectUrl) throw new Error(`No se puede cargar ${asset.name}.`);
      promise = fetch(asset.objectUrl).then((response) => {
        if (!response.ok) throw new Error(`No se puede leer ${asset.name}.`);
        return response.blob();
      });
      blobCache.set(asset.id, promise);
    }
    return promise;
  };
  const getInput = async (asset: AssetRecord) => {
    let input = inputCache.get(asset.id);
    if (!input) {
      input = new Input({ source: new BlobSource(await getBlob(asset)), formats: ALL_FORMATS });
      inputCache.set(asset.id, input);
    }
    return input;
  };

  const visualClips = project.timeline.filter((clip) =>
    (clip.type === 'video' || clip.type === 'image' || clip.type === 'text') && !trackFor(project, clip)?.hidden
  );
  const imageAssets = visualClips.filter((clip) => clip.type === 'image' && clip.assetId)
    .map((clip) => assetById.get(clip.assetId!)).filter((asset): asset is AssetRecord => !!asset);
  for (const asset of new Map(imageAssets.map((asset) => [asset.id, asset])).values()) {
    imageCache.set(asset.id, await createImageBitmap(await getBlob(asset)));
  }

  options.onProgress(3);
  const sampleRate = 48_000;
  const offlineAudio = new OfflineAudioContext(2, Math.max(1, Math.ceil(project.duration * sampleRate)), sampleRate);
  let hasAudio = false;
  for (const clip of project.timeline.filter((item) => (item.type === 'audio' || item.type === 'video') && !trackFor(project, item)?.muted && !trackFor(project, item)?.hidden)) {
    const asset = clip.assetId ? assetById.get(clip.assetId) : undefined;
    if (!asset) continue;
    const input = await getInput(asset);
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack || !(await audioTrack.canDecode())) continue;
    const sink = new AudioBufferSink(audioTrack);
    const rate = clip.playbackRate || 1;
    const trimStart = clip.trimStart || 0;
    const trimEnd = trimStart + clip.duration * rate;
    const chunks: Array<{ buffer: AudioBuffer; offset: number; duration: number; sourceStart: number }> = [];
    for await (const wrapped of sink.buffers(trimStart, trimEnd)) {
      const sourceStart = Math.max(trimStart, wrapped.timestamp);
      const sourceEnd = Math.min(trimEnd, wrapped.timestamp + wrapped.duration);
      const offset = Math.max(0, sourceStart - wrapped.timestamp);
      const duration = Math.min(sourceEnd - sourceStart, wrapped.buffer.duration - offset);
      if (duration > 0) chunks.push({ buffer: wrapped.buffer, offset, duration, sourceStart });
    }
    let reverseCursor = clip.start;
    const scheduled = clip.reverse ? [...chunks].reverse() : chunks;
    for (const chunk of scheduled) {
      const node = offlineAudio.createBufferSource();
      node.buffer = clip.reverse ? reverseAudioSlice(offlineAudio, chunk.buffer, chunk.offset, chunk.duration) : chunk.buffer;
      node.playbackRate.value = rate;
      node.connect(offlineAudio.destination);
      const when = clip.reverse ? reverseCursor : clip.start + (chunk.sourceStart - trimStart) / rate;
      node.start(when, clip.reverse ? 0 : chunk.offset, chunk.duration);
      if (clip.reverse) reverseCursor += chunk.duration / rate;
      hasAudio = true;
    }
  }
  const mixedAudio = hasAudio ? await offlineAudio.startRendering() : null;
  options.onProgress(8);

  const fps = Math.max(1, project.fps);
  const frameDuration = 1 / fps;
  const frameCount = Math.max(1, Math.ceil(project.duration * fps));
  const videoReaders = new Map<string, VideoClipReader>();
  for (const clip of visualClips.filter((item) => item.type === 'video')) {
    const asset = clip.assetId ? assetById.get(clip.assetId) : undefined;
    if (!asset) continue;
    const input = await getInput(asset);
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack || !(await videoTrack.canDecode())) continue;
    const sink = new VideoSampleSink(videoTrack);
    if (clip.reverse) {
      videoReaders.set(clip.id, { sink });
    } else {
      const rate = clip.playbackRate || 1;
      const timestamps: number[] = [];
      for (let frame = 0; frame < frameCount; frame += 1) {
        const time = frame * frameDuration;
        if (time >= clip.start && time < clip.start + clip.duration) timestamps.push((time - clip.start) * rate + (clip.trimStart || 0));
      }
      videoReaders.set(clip.id, { iterator: sink.samplesAtTimestamps(timestamps) });
    }
  }

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const audioSource = mixedAudio ? new AudioBufferSource({ codec: 'aac', bitrate: 192_000 }) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  const orderedVisualClips = [...visualClips].sort((a, b) => trackIndex(project, b) - trackIndex(project, a));
  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = frame * frameDuration;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const clip of orderedVisualClips) {
      if (time < clip.start || time >= clip.start + clip.duration) continue;
      if (clip.type === 'text') { drawText(context, project, clip, time); continue; }
      const asset = clip.assetId ? assetById.get(clip.assetId) : undefined;
      if (!asset) continue;
      if (clip.type === 'image') {
        const image = imageCache.get(asset.id);
        if (image) drawMedia(context, project, clip, time, image.width, image.height, (sx, sy, sw, sh, x, y, width, height) => context.drawImage(image, sx, sy, sw, sh, x, y, width, height));
        continue;
      }
      const reader = videoReaders.get(clip.id);
      if (!reader) continue;
      const rate = clip.playbackRate || 1;
      const sourceTime = (clip.trimStart || 0) + (clip.reverse ? Math.max(0, clip.duration * rate - (time - clip.start) * rate - frameDuration * rate) : (time - clip.start) * rate);
      const sample = reader.sink ? await reader.sink.getSample(sourceTime) : (await reader.iterator!.next()).value;
      if (!sample) continue;
      drawMedia(context, project, clip, time, sample.displayWidth, sample.displayHeight, (sx, sy, sw, sh, x, y, width, height) => sample.draw(context, sx, sy, sw, sh, x, y, width, height));
      sample.close();
    }
    await videoSource.add(time, frameDuration, { keyFrame: frame % Math.max(1, fps * 2) === 0 });
    options.onProgress(8 + Math.round(((frame + 1) / frameCount) * 87));
  }

  if (audioSource && mixedAudio) await audioSource.add(mixedAudio);
  await output.finalize();
  options.onProgress(100);
  imageCache.forEach((image) => image.close());
  inputCache.forEach((input) => input.dispose());
  if (!target.buffer) throw new Error('No se pudo crear el archivo MP4.');
  return new Blob([target.buffer], { type: 'video/mp4' });
}
