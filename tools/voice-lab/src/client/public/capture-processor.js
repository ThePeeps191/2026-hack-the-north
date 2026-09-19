class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      this.port.postMessage(channel);
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
