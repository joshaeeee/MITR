import { ElderService } from '../elder/elder-service.js';
import { DeviceControlService } from './device-control-service.js';

export class DeviceService {
  private readonly elder = new ElderService();
  private readonly control = new DeviceControlService();

  async status(userId: string) {
    const [legacyStatus, productionDevices] = await Promise.all([
      this.elder.getDeviceStatus(userId),
      this.control.listDevicesForUser(userId)
    ]);

    return {
      ...legacyStatus,
      productionDevices
    };
  }

  async link(userId: string, input: { serialNumber: string; firmwareVersion?: string }) {
    return this.elder.linkDevice(userId, input);
  }

  async unlink(userId: string) {
    return this.elder.unlinkDevice(userId);
  }
}
