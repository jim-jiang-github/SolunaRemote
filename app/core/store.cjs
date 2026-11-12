const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  DEFAULT_SETTINGS,
  validateSettings,
  validateDevice,
  text,
  appName,
} = require("./validation.cjs");

class Store {
  constructor(directory) {
    this.file = path.join(directory, "devices.json");
    this.data = { version: 1, devices: [], settings: { ...DEFAULT_SETTINGS } };
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        data.version !== 1 ||
        !Array.isArray(data.devices) ||
        data.devices.length > 200
      )
        throw new Error("设备数据版本或格式无效。");
      data.settings = validateSettings(data.settings);
      const ids = new Set();
      const addresses = new Set();
      data.devices = data.devices.map((device) => {
        const valid = validateDevice(device);
        const id = text(device.id, "设备 ID", 64);
        if (
          ids.has(id) ||
          addresses.has(valid.address) ||
          typeof device.favorite !== "boolean" ||
          !Array.isArray(device.shortcuts) ||
          device.shortcuts.length > 12
        )
          throw new Error("设备数据包含重复或无效记录。");
        ids.add(id);
        addresses.add(valid.address);
        return {
          ...valid,
          id,
          favorite: device.favorite,
          lastPairedAt:
            typeof device.lastPairedAt === "string"
              ? device.lastPairedAt
              : null,
          shortcuts: device.shortcuts.map((entry) => ({
            id: text(entry.id, "快捷方式 ID"),
            name: text(entry.name, "快捷方式名称", 48),
            app: appName(entry.app),
          })),
        };
      });
      this.data = data;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(`无法读取设备数据，原文件已保留：${error.message}`);
    }
  }

  snapshot() {
    return structuredClone(this.data);
  }

  commit(mutator) {
    const next = structuredClone(this.data);
    const result = mutator(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.data = next;
    return result;
  }

  device(id) {
    const device = this.data.devices.find((entry) => entry.id === id);
    if (!device) throw new Error("设备不存在，请刷新设备列表。");
    return structuredClone(device);
  }

  add(input) {
    const valid = validateDevice(input);
    if (this.data.devices.length >= 200)
      throw new Error("设备数量已达到上限（200）。");
    if (this.data.devices.some((device) => device.address === valid.address))
      throw new Error("这个地址已经添加过了。");
    return this.commit((data) => {
      const device = {
        ...valid,
        id: randomUUID(),
        favorite: false,
        lastPairedAt: null,
        shortcuts: [],
      };
      data.devices.push(device);
      return device;
    });
  }

  remove(id) {
    this.device(id);
    this.commit((data) => {
      data.devices = data.devices.filter((device) => device.id !== id);
    });
  }

  update(id, update) {
    this.device(id);
    return this.commit((data) => {
      const device = data.devices.find((entry) => entry.id === id);
      update(device);
      return structuredClone(device);
    });
  }

  settings(input) {
    const settings = validateSettings(input);
    this.commit((data) => {
      data.settings = settings;
    });
  }
}

module.exports = { Store };
