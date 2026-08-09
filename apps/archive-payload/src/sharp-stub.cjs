// Keep webpack and the Worker build away from Sharp's native libvips module.
// The archive uses R2 bytes unchanged and disables Payload image transforms;
// this small compatibility surface is only for Next's build-time probes.
function sharpWorkerStub(input) {
  const bytes = input == null ? Buffer.alloc(0) : Buffer.from(input)
  const chain = {
    timeout() {
      return chain
    },
    rotate() {
      return chain
    },
    resize() {
      return chain
    },
    png() {
      return chain
    },
    jpeg() {
      return chain
    },
    webp() {
      return chain
    },
    avif() {
      return chain
    },
    tiff() {
      return chain
    },
    toFormat() {
      return chain
    },
    withMetadata() {
      return chain
    },
    ensureAlpha() {
      return chain
    },
    removeAlpha() {
      return chain
    },
    flatten() {
      return chain
    },
    trim() {
      return chain
    },
    metadata: async () => ({ width: 1, height: 1 }),
    toBuffer: async () => bytes,
  }
  return chain
}

sharpWorkerStub.block = () => undefined
sharpWorkerStub.unblock = () => undefined
sharpWorkerStub.cache = () => undefined
sharpWorkerStub.concurrency = (value) => (value === undefined ? 1 : value)
sharpWorkerStub.simd = () => undefined
sharpWorkerStub.format = () => undefined
sharpWorkerStub.versions = {}

module.exports = sharpWorkerStub
