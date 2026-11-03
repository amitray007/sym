// A minimal valid WAV file: a 44-byte RIFF header and a few samples of 8 kHz, 16-bit mono
// silence. Tests use it where they check the bytes that reach a transcription request.
export function wavBytes(samples = 8): Uint8Array {
  const dataSize = samples * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 16000, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  return new Uint8Array(view.buffer);
}
