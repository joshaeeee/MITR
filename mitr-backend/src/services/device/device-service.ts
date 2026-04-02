import { ElderService } from '../elder/elder-service.js';
import { DeviceControlService, type ClaimedDeviceSummary, type DevicePairingSummary } from './device-control-service.js';

const CONNECTED_WINDOW_MS = 45_000;
const RECOVERING_WINDOW_MS = 3 * 60 * 1000;

type ConnectedDeviceState = 'connected' | 'recovering' | 'offline';
export type ProductionDeviceState = 'unpaired' | 'pairing' | ConnectedDeviceState;

export interface ProductionDeviceHealthSummary {
  state: ConnectedDeviceState;
  displayName: string | null;
  deviceId: string;
  elderId: string | null;
  claimedAt: number;
  firmwareVersion: string | null;
  hardwareRev: string | null;
  lastSeenAt: number | null;
  lastHeartbeatAt: number | null;
  sessionStatus: 'issued' | 'active' | 'ended' | null;
  lastEndReason: string | null;
  wifiRssiDbm: number | null;
  batteryPct: number | null;
  networkType: string | null;
  ipAddress: string | null;
}

export interface ProductionDeviceSummary {
  state: ProductionDeviceState;
  displayName: string | null;
  deviceId: string | null;
  elderId: string | null;
  claimedAt: number | null;
  firmwareVersion: string | null;
  hardwareRev: string | null;
  lastSeenAt: number | null;
  lastHeartbeatAt: number | null;
  sessionStatus: 'issued' | 'active' | 'ended' | null;
  lastEndReason: string | null;
  wifiRssiDbm: number | null;
  batteryPct: number | null;
  networkType: string | null;
  ipAddress: string | null;
  activePairing: DevicePairingSummary | null;
}

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export class DeviceService {
  private readonly elder = new ElderService();
  private readonly control = new DeviceControlService();

  private pickPrimaryDevice(
    devices: ClaimedDeviceSummary[],
    context: { familyId: string; elderId: string | null } | null
  ): ClaimedDeviceSummary | null {
    const activeDevices = devices.filter((device) => device.revokedAt === null);
    if (activeDevices.length === 0) return null;

    if (context?.elderId) {
      const elderMatch = activeDevices.find((device) => device.elderId === context.elderId);
      if (elderMatch) return elderMatch;
    }

    if (context?.familyId) {
      const familyMatch = activeDevices.find((device) => device.familyId === context.familyId);
      if (familyMatch) return familyMatch;
    }

    return activeDevices[0] ?? null;
  }

  private summarizePrimaryDevice(device: ClaimedDeviceSummary | null): ProductionDeviceHealthSummary | null {
    if (!device) return null;

    const heartbeat =
      device.metadata.lastHeartbeat && typeof device.metadata.lastHeartbeat === 'object'
        ? (device.metadata.lastHeartbeat as Record<string, unknown>)
        : {};
    const lastSeenAt = device.lastSeenAt;
    const ageMs = lastSeenAt === null ? Number.POSITIVE_INFINITY : Math.max(0, Date.now() - lastSeenAt);
    const state: ConnectedDeviceState =
      ageMs <= CONNECTED_WINDOW_MS ? 'connected' : ageMs <= RECOVERING_WINDOW_MS ? 'recovering' : 'offline';

    return {
      state,
      displayName: device.displayName,
      deviceId: device.deviceId,
      elderId: device.elderId,
      claimedAt: device.claimedAt,
      firmwareVersion: device.firmwareVersion,
      hardwareRev: device.hardwareRev,
      lastSeenAt,
      lastHeartbeatAt: device.lastSession?.lastHeartbeatAt ?? null,
      sessionStatus: device.lastSession?.status ?? null,
      lastEndReason: device.lastSession?.endReason ?? null,
      wifiRssiDbm: readNumber(heartbeat.wifiRssiDbm),
      batteryPct: readNumber(heartbeat.batteryPct),
      networkType: readString(heartbeat.networkType),
      ipAddress: readString(heartbeat.ipAddress)
    };
  }

  private summarizeForUi(
    primaryProductionDevice: ProductionDeviceHealthSummary | null,
    activePairing: DevicePairingSummary | null
  ): ProductionDeviceSummary {
    if (!primaryProductionDevice) {
      return {
        state: activePairing ? 'pairing' : 'unpaired',
        displayName: activePairing?.displayName ?? null,
        deviceId: activePairing?.deviceId ?? null,
        elderId: activePairing?.elderId ?? null,
        claimedAt: null,
        firmwareVersion: null,
        hardwareRev: null,
        lastSeenAt: null,
        lastHeartbeatAt: null,
        sessionStatus: null,
        lastEndReason: null,
        wifiRssiDbm: null,
        batteryPct: null,
        networkType: null,
        ipAddress: null,
        activePairing
      };
    }

    return {
      ...primaryProductionDevice,
      activePairing
    };
  }

  async status(userId: string, options: { includeLegacy?: boolean } = {}) {
    const includeLegacy = options.includeLegacy ?? true;
    const [legacyStatus, productionDevices, activePairing, familyContext] = await Promise.all([
      includeLegacy ? this.elder.getDeviceStatus(userId) : Promise.resolve(null),
      this.control.listDevicesForUser(userId),
      this.control.getLatestActivePairingForUser(userId),
      this.control.getCurrentFamilyContextForUser(userId)
    ]);

    const primaryProductionDevice = this.summarizePrimaryDevice(this.pickPrimaryDevice(productionDevices, familyContext));
    const productionDevice = this.summarizeForUi(primaryProductionDevice, activePairing);

    return {
      ...(legacyStatus ?? {}),
      productionDevices,
      primaryProductionDevice,
      activePairing,
      productionDevice
    };
  }

  async link(userId: string, input: { serialNumber: string; firmwareVersion?: string }) {
    return this.elder.linkDevice(userId, input);
  }

  async unlink(userId: string) {
    return this.elder.unlinkDevice(userId);
  }
}
