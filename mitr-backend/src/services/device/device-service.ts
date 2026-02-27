import { ElderService } from '../elder/elder-service.js';

export class DeviceService {
  private readonly elder = new ElderService();

  async status(userId: string) {
    return this.elder.getDeviceStatus(userId);
  }

  async link(userId: string, input: { serialNumber: string; firmwareVersion?: string }) {
    return this.elder.linkDevice(userId, input);
  }

  async unlink(userId: string) {
    return this.elder.unlinkDevice(userId);
  }
}
