const express = require("express");
const app = express();
const server = require("http").createServer(app);
const io = require("socket.io")(server);
const path = require("path");
const port = process.env.PORT || 3000;

const { SerialPort } = require("serialport");
require("dotenv").config();

const { asciiToString } = require("./src/utils/functions");

const autoPurchaseEnabled = process.env.AUTO_PURCHASE === "true";

app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// Configuration
// ============================================================

const serialPort = new SerialPort({
  // Windows
  // path: "COM3",

  // Raspberry Pi example:
  path: "/dev/ttyAMA0",

  baudRate: 9600,
});

let pythonSocket = null;
let vmcSimulatorSocket = null;

// ============================================================
// Machine State
// ============================================================

let vmcStatus = "";
let priceCheck = false;
let dropSensor = false;
let processEnd = false;
let cashSaleCheck = false;

let productPriceHex = "";
let productPrice;
let productId;

let vmcPriceString = "";
let vmcCashString = "";
let dropSensorString = "";
let processEndString = "";

// ============================================================
// Status Timeout Monitoring
// ============================================================

let idleTimeoutTimer = null;
let rejectedTimeoutTimer = null;
let autoPurchaseTimer = null;
let connectTimeoutTimer = null;
let initSequenceTimer = null;
let initReadyTimer = null;

const IDLE_TIMEOUT_MS = 15000; // 15 seconds
const REJECTED_TIMEOUT_MS = 5000; // 5 seconds
const AUTO_PURCHASE_DELAY_MS = 4000; // 2 seconds delay before auto-purchase
const CONNECT_TIMEOUT_MS = 10000; // watchdog while waiting in "connect"
const INIT_STEP_DELAY_MS = 3000; // delay between the two initialization commands
const READY_RESPONSE_TIMEOUT_MS = 5000; // fallback when the VMC stays silent after initialization

// Initialization / reset recovery state (see "MDB Frame Decoding" below)
let initializationInProgress = false;
let initializationSequenceDone = false;
let initValidResponseReceived = false;
let initEvidenceHex = null;
let recoveryMode = false;

let vmcTest;

// ============================================================
// Logging Helpers
// ============================================================

const log = (message, data = null) => {
  const timestamp = new Date().toISOString();

  if (data !== null) {
    console.log(`[${timestamp}] ${message}`, data);
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
};

const runCashOnReset = () => {
  if (initializationInProgress) {
    log("AUTO RESET: Skipped (VMC initialization/recovery in progress)");
    return;
  }

  log("AUTO RESET: Running cash on sequence (machine stuck recovery)");

  setVmcStatus("enable");

  const result = checksum([0x06]);
  writeMdb(result, "VMC CASH MODE STEP 1");

  setTimeout(() => {
    const result2 = checksum([0x07]);
    writeMdb(result2, "VMC CASH MODE STEP 2");

    setTimeout(() => {
      const result3 = checksum([0x06]);
      writeMdb(result3, "VMC CASH MODE STEP 3");

      setTimeout(() => {
        const result4 = checksum([0x07]);
        writeMdb(result4, "VMC CASH MODE STEP 4");
        log("AUTO RESET: Cash mode sequence completed");
      }, 100);
    }, 100);
  }, 100);
};

const triggerAutoPurchase = () => {
  if (initializationInProgress) {
    log("AUTO PURCHASE: Skipped (VMC initialization/recovery in progress)");
    return;
  }

  if (vmcStatus !== "" && vmcStatus !== "enable") {
    log(`AUTO PURCHASE: Skipped (vmcStatus="${vmcStatus}")`);
    return;
  }

  log("AUTO PURCHASE: Triggering purchase request");

  setVmcStatus("connect");

  const result = checksum([0x03, 0x03, 0xe8]);
  writeMdb(result, "VMC AUTO PURCHASE REQUEST");
};

const setVmcStatus = (status) => {
  if (vmcStatus !== status) {
    log(`VMC STATUS: ${vmcStatus || "INITIAL"} -> ${status}`);
  }

  // Clear any running timeout timers when leaving monitored states
  // (idleBit keeps the idle timer running while a split command collects)
  if (
    (vmcStatus === "idle" || vmcStatus === "idleBit") &&
    status !== "idle" &&
    status !== "idleBit"
  ) {
    if (idleTimeoutTimer) {
      clearTimeout(idleTimeoutTimer);
      idleTimeoutTimer = null;
      log("IDLE TIMER: Cleared (status changed from idle)");
    }
  }

  if (vmcStatus === "rejected" && status !== "rejected") {
    if (rejectedTimeoutTimer) {
      clearTimeout(rejectedTimeoutTimer);
      rejectedTimeoutTimer = null;
      log("REJECTED TIMER: Cleared (status changed from rejected)");
    }
  }

  // Clear auto-purchase timer when leaving enable/empty status
  if (
    (vmcStatus === "" || vmcStatus === "enable") &&
    status !== "" &&
    status !== "enable"
  ) {
    if (autoPurchaseTimer) {
      clearTimeout(autoPurchaseTimer);
      autoPurchaseTimer = null;
      log("AUTO PURCHASE TIMER: Cleared (status changed from enable)");
    }
  }

  vmcStatus = status;

  // Start idle timeout when entering idle status (or idleBit, a split
  // command still collecting fragments — never leave it unguarded)
  if ((status === "idle" || status === "idleBit") && !idleTimeoutTimer) {
    log(`IDLE TIMER: Starting ${IDLE_TIMEOUT_MS / 1000}s timeout`);
    idleTimeoutTimer = setTimeout(() => {
      if (vmcStatus === "idle" || vmcStatus === "idleBit") {
        log("IDLE TIMEOUT: Machine stuck in idle for 15s, resetting to enable");
        idleTimeoutTimer = null;
        priceCheck = false;
        dropSensor = false;
        processEnd = false;
        cashSaleCheck = false;
        vmcPriceString = "";
        vmcCashString = "";
        dropSensorString = "";
        processEndString = "";
        runCashOnReset();
      }
    }, IDLE_TIMEOUT_MS);
  }

  // Start rejected timeout when entering rejected status
  if (status === "rejected" && !rejectedTimeoutTimer) {
    log(`REJECTED TIMER: Starting ${REJECTED_TIMEOUT_MS / 1000}s timeout`);
    rejectedTimeoutTimer = setTimeout(() => {
      if (vmcStatus === "rejected") {
        log(
          "REJECTED TIMEOUT: Machine stuck in rejected for 5s, running cash on reset",
        );
        rejectedTimeoutTimer = null;
        runCashOnReset();
      }
    }, REJECTED_TIMEOUT_MS);
  }

  // Connection watchdog: never stay in "connect" waiting forever for the
  // VMC to acknowledge a purchase request.
  if (status === "connect") {
    if (!connectTimeoutTimer) {
      log(`CONNECT WATCHDOG: Starting ${CONNECT_TIMEOUT_MS / 1000}s timeout`);
      connectTimeoutTimer = setTimeout(() => {
        connectTimeoutTimer = null;

        if (vmcStatus === "connect") {
          log("VMC CONNECTION TIMEOUT", {
            waitedMs: CONNECT_TIMEOUT_MS,
            interpretation: "No valid VMC response to the purchase request",
            status: vmcStatus,
          });

          startRecovery("connection timeout");
        }
      }, CONNECT_TIMEOUT_MS);
    }
  } else if (connectTimeoutTimer) {
    clearTimeout(connectTimeoutTimer);
    connectTimeoutTimer = null;
    log("CONNECT WATCHDOG: Cleared (status changed from connect)");
  }

  // Auto-purchase: trigger purchase when returning to enable/empty status
  if ((status === "" || status === "enable") && !autoPurchaseTimer) {
    if (initializationInProgress) {
      log("AUTO PURCHASE: Suppressed (VMC initialization/recovery in progress)");
    } else if (autoPurchaseEnabled) {
      log(
        `AUTO PURCHASE: Detected idle machine, starting ${AUTO_PURCHASE_DELAY_MS / 1000}s timer`,
      );
      autoPurchaseTimer = setTimeout(() => {
        autoPurchaseTimer = null;
        triggerAutoPurchase();
      }, AUTO_PURCHASE_DELAY_MS);
    }
  }
};

const writeMdb = (buffer, description = "MDB command") => {
  log(`${description}: TX`, buffer.toString("hex").toUpperCase());

  serialPort.write(buffer, (error) => {
    if (error) {
      log(`${description}: WRITE ERROR`, error.message);
    }
  });
};

const emitVendResult = (status, code) => {
  log(`VMC VEND RESULT: ${status} code=${code}`);

  if (pythonSocket) {
    pythonSocket.emit("vend result", { status, code });
    log(`VMC -> PYTHON: vend result`, { status, code });
  } else {
    log("VEND RESULT: Python is not connected");
  }
};

// ============================================================
// Checksum
// ============================================================

const checksum = (array) => {
  let checksumValue = 0x00;

  for (const element of array) {
    checksumValue += element;
  }

  array.push(checksumValue);

  return Buffer.from(array);
};

// ============================================================
// MDB Frame Decoding (HAT serial protocol)
// ============================================================
//
// The HAT forwards raw MDB bus traffic as ASCII-hex text between STX (0x02)
// and ETX (0x03). Example: raw '02 31 30 31 30 03' -> payload "1010" ->
// MDB frame bytes 10 10. The first byte is the MDB address/command byte
// (cashless device 1 lives at address 0x10), the last byte is the additive
// checksum used everywhere else in this application (see checksum()).
//
// Known VMC -> cashless device 1 command bytes:
//   0x10 RESET        0x11 SETUP          0x12 POLL
//   0x13 VEND         0x14 READER         0x17 EXPANSION

const stripFrameDelimiters = (text) => text.replace(/[\x02\x03]/g, "");

const decodeMdbPayload = (payload) => {
  if (!/^[0-9a-fA-F]+$/.test(payload)) {
    return null;
  }

  // Serial reads can be truncated; decode complete byte pairs only.
  const usableLength = payload.length - (payload.length % 2);
  const bytes = [];

  for (let i = 0; i < usableLength; i += 2) {
    bytes.push(parseInt(payload.substring(i, i + 2), 16));
  }

  return bytes.length > 0 ? bytes : null;
};

const describeMdbFrame = (bytes, payload) => {
  const hex = Buffer.from(bytes).toString("hex").toUpperCase();
  const incomplete = payload.length % 2 !== 0;

  let checksumValue = 0x00;
  for (let i = 0; i < bytes.length - 1; i++) {
    checksumValue += bytes[i];
  }
  checksumValue &= 0xff;

  const hasChecksum = bytes.length > 1;
  const checksumByte = hasChecksum ? bytes[bytes.length - 1] : null;
  const checksumOk = hasChecksum && checksumValue === checksumByte;

  const command = bytes[0];
  let interpretation = "Unrecognized MDB frame";

  if (command === 0x00) {
    interpretation = "MDB ACK from VMC (0x00)";
  } else if (command === 0x10) {
    interpretation =
      "MDB CASHLESS DEVICE 1 RESET: command byte 0x10 (device address 0x10 + command 0x00 RESET) + checksum 0x10";
  } else if (command === 0x11 && bytes[1] === 0x00) {
    interpretation = "MDB SETUP / CONFIGURATION DATA REQUEST (0x11 0x00)";
    if (bytes.length > 3) {
      interpretation += ` + ${bytes.length - 3} extra byte(s) not defined by the MDB cashless SETUP command`;
    }
  } else if (command === 0x11 && bytes[1] === 0x01 && bytes.length >= 6) {
    const minPrice = bytes[2] | (bytes[3] << 8);
    const maxPrice = bytes[4] | (bytes[5] << 8);
    interpretation = `MDB SETUP / MIN-MAX PRICE (0x11 0x01): min=${minPrice} max=${maxPrice}`;
  } else if (command === 0x11) {
    interpretation = "MDB SETUP (0x11) with unknown VMC data";
  } else if (command === 0x12) {
    interpretation = "MDB POLL (0x12)";
  } else if (command === 0x14 && bytes[1] === 0x01) {
    interpretation = "MDB READER ENABLE (0x14 0x01)";
  } else if (command === 0x14) {
    interpretation = "MDB READER CONTROL (0x14)";
  } else if (command === 0x17) {
    const subCommand = bytes[1] ?? 0x00;
    interpretation = `MDB EXPANSION (0x17 sub-command 0x${subCommand
      .toString(16)
      .toUpperCase()
      .padStart(2, "0")})`;

    const asciiData = bytes
      .slice(2, Math.max(2, bytes.length - 1))
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
      .join("");

    if (asciiData.trim().length > 0) {
      interpretation += ` data ASCII "${asciiData}"`;
    }
  }

  return {
    hex,
    interpretation,
    incomplete,
    checksumOk,
    checksumValue,
    checksumByte,
  };
};

const describeChecksum = (frameInfo) => {
  if (frameInfo.checksumByte === null) {
    return "n/a";
  }

  const expected = frameInfo.checksumValue
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");
  const received = frameInfo.checksumByte
    .toString(16)
    .toUpperCase()
    .padStart(2, "0");

  return frameInfo.checksumOk
    ? "ok"
    : `mismatch (expected 0x${expected}, received 0x${received})`;
};

// ============================================================
// Initialization / Reset Recovery
// ============================================================
//
// The VMC can reset cashless device 1 at any time (MDB frame "1010").
// The device must then be re-initialized before new purchase requests are
// sent, otherwise the machine keeps resetting us and the application stays
// stuck in "connect". The recovery replays the same initialization sequence
// this application already uses at startup (RESET + CONFIGURATION commands
// of the supported HAT protocol); no MDB responses are invented for frames
// the HAT protocol does not define a response for.

const clearTransactionState = () => {
  priceCheck = false;
  dropSensor = false;
  processEnd = false;
  cashSaleCheck = false;
  vmcPriceString = "";
  vmcCashString = "";
  dropSensorString = "";
  processEndString = "";
  productPriceHex = "";
  productPrice = undefined;
  productId = undefined;
};

const cancelObsoleteTimers = () => {
  if (idleTimeoutTimer) {
    clearTimeout(idleTimeoutTimer);
    idleTimeoutTimer = null;
    log("IDLE TIMER: Cleared (VMC reset/recovery)");
  }

  if (rejectedTimeoutTimer) {
    clearTimeout(rejectedTimeoutTimer);
    rejectedTimeoutTimer = null;
    log("REJECTED TIMER: Cleared (VMC reset/recovery)");
  }

  if (autoPurchaseTimer) {
    clearTimeout(autoPurchaseTimer);
    autoPurchaseTimer = null;
    log("AUTO PURCHASE TIMER: Cleared (VMC reset/recovery)");
  }

  if (connectTimeoutTimer) {
    clearTimeout(connectTimeoutTimer);
    connectTimeoutTimer = null;
    log("CONNECT WATCHDOG: Cleared (VMC reset/recovery)");
  }

  if (initReadyTimer) {
    clearTimeout(initReadyTimer);
    initReadyTimer = null;
    log("INIT READY TIMER: Cleared (VMC reset/recovery)");
  }
};

const evaluateCashlessReady = () => {
  if (!initializationInProgress || !initializationSequenceDone) {
    return;
  }

  if (initValidResponseReceived) {
    completeInitialization(`valid VMC response ${initEvidenceHex}`);
    return;
  }

  if (!initReadyTimer) {
    log(
      `VMC INITIALIZATION: Waiting for a valid VMC response (max ${READY_RESPONSE_TIMEOUT_MS / 1000}s)`,
    );
    initReadyTimer = setTimeout(() => {
      initReadyTimer = null;
      completeInitialization(
        `no valid VMC response within ${READY_RESPONSE_TIMEOUT_MS / 1000}s after initialization (compatibility fallback)`,
      );
    }, READY_RESPONSE_TIMEOUT_MS);
  }
};

const completeInitialization = (evidence) => {
  if (initReadyTimer) {
    clearTimeout(initReadyTimer);
    initReadyTimer = null;
  }

  initializationInProgress = false;
  initializationSequenceDone = false;

  log("VMC CASHLESS READY", { evidence });

  if (recoveryMode) {
    recoveryMode = false;
    log("VMC RECOVERY COMPLETED", { evidence });

    // Restore the enabled state; this re-arms the existing AUTO_PURCHASE timer
    setVmcStatus("enable");
    return;
  }

  // Kick auto-purchase after initial boot if enabled (existing behavior)
  if (autoPurchaseEnabled && (vmcStatus === "" || vmcStatus === "enable")) {
    log("AUTO PURCHASE: Initial boot complete, starting first cycle");
    setVmcStatus(vmcStatus); // re-enter current status to trigger timer
  }
};

const startInitialization = (source) => {
  if (initializationInProgress) {
    log(
      "VMC INITIALIZATION: Start request ignored (initialization already in progress)",
      source,
    );
    return;
  }

  initializationInProgress = true;
  initializationSequenceDone = false;
  initValidResponseReceived = false;
  initEvidenceHex = null;

  log("VMC INITIALIZATION STARTED", { source });

  // Reset
  const resetResult = checksum([0x00]);
  writeMdb(resetResult, "VMC INITIALIZATION COMMAND (RESET)");

  initSequenceTimer = setTimeout(() => {
    initSequenceTimer = null;

    // Configuration Data
    const configResult = checksum([
      0x01, 0x03, 0x15, 0x86, 0x01, 0x00, 0x05, 0x0c,
    ]);
    writeMdb(configResult, "VMC INITIALIZATION COMMAND (CONFIGURATION)");

    initializationSequenceDone = true;
    log("VMC INITIALIZATION COMPLETED", { source });

    if (recoveryMode) {
      // Recovery only restores AUTO_PURCHASE once the VMC has proven it is
      // talking to us again (or the compatibility fallback expires).
      evaluateCashlessReady();
    } else {
      // Boot keeps the original startup behavior/timing.
      completeInitialization("startup initialization sequence completed");
    }
  }, INIT_STEP_DELAY_MS);
};

const startRecovery = (reason) => {
  log("VMC RECOVERY STARTED", { reason });

  recoveryMode = true;

  cancelObsoleteTimers();
  clearTransactionState();
  setVmcStatus("init");

  startInitialization("recovery");
};

const markValidVmcResponse = (hex) => {
  initValidResponseReceived = true;
  initEvidenceHex = hex;
  evaluateCashlessReady();
};

const handleVmcReset = (frameInfo) => {
  log("VMC RESET DETECTED", {
    hex: frameInfo.hex,
    interpretation: frameInfo.interpretation,
    checksum: describeChecksum(frameInfo),
    status: vmcStatus,
  });

  if (initializationInProgress) {
    log(
      "VMC RESET DETECTED: Ignored (initialization/recovery already in progress - no overlapping sequences)",
    );
    return;
  }

  startRecovery(`VMC reset cashless device 1 (${frameInfo.hex})`);
};

const handleVmcInitializationMessage = (frameInfo) => {
  log("VMC INITIALIZATION RESPONSE", {
    hex: frameInfo.hex,
    interpretation: frameInfo.interpretation,
    checksum: describeChecksum(frameInfo),
    status: vmcStatus,
  });

  if (!frameInfo.incomplete && frameInfo.checksumOk) {
    markValidVmcResponse(frameInfo.hex);
    return;
  }

  log(
    "VMC INITIALIZATION RESPONSE: Not counted as ready evidence (frame incomplete or checksum mismatch) - no response sent (the HAT protocol defines none for this frame)",
  );
};

// ============================================================
// Dummy Test Socket function in place of vending machine
// ============================================================
const processVmcData = async (vmcChar, rawHex = null) => {
  // We don't need noisy logging for simple 00 responses.
  // Log meaningful MDB responses only.
  if (vmcChar !== "00") {
    log("VMC RX", {
      hex: rawHex?.toUpperCase(),
      data: vmcChar,
      status: vmcStatus,
    });
  }

  // ==========================================================
  // MDB Frame Decoding (HAT serial protocol)
  // ==========================================================

  const payload = stripFrameDelimiters(vmcChar);
  const frameBytes = decodeMdbPayload(payload);

  if (frameBytes) {
    const command = frameBytes[0];

    // VMC-initiated reset of cashless device 1 ("1010")
    if (command === 0x10 && frameBytes.length >= 2) {
      handleVmcReset(describeMdbFrame(frameBytes, payload));
      return;
    }

    // VMC initialization / management commands (SETUP/POLL/READER/EXPANSION)
    if (
      frameBytes.length >= 2 &&
      (command === 0x11 ||
        command === 0x12 ||
        command === 0x14 ||
        command === 0x17)
    ) {
      handleVmcInitializationMessage(describeMdbFrame(frameBytes, payload));
      return;
    }

    // ACK (0x00) and VEND traffic (0x13) keep the existing handling below
    if (command === 0x00 || command === 0x13) {
      markValidVmcResponse(payload.toUpperCase());
    } else if (frameBytes.length >= 2) {
      // Unknown frames must never change state and must never provoke an
      // ACK/RESET/CASH ON/purchase response.
      const frameInfo = describeMdbFrame(frameBytes, payload);
      log("VMC UNKNOWN RESPONSE", {
        hex: frameInfo.hex,
        interpretation: frameInfo.interpretation,
        checksum: describeChecksum(frameInfo),
        status: vmcStatus,
        action: "ignored (no response sent for unknown frames)",
      });
      return;
    }
  }

  // ==========================================================
  // Cash Sale - Multi Packet Response
  // ==========================================================

  if (cashSaleCheck === true && vmcChar !== "00" && vmcStatus === "cashSale") {
    setVmcStatus("enable");

    cashSaleCheck = false;

    vmcCashString += vmcChar;

    const startByte = vmcCashString.slice(0, 4);

    if (startByte === "1305") {
      let cashProductPrice = vmcCashString.slice(8, 12);
      let cashProductId = vmcCashString.slice(12, 16);

      if (cashProductPrice.length === 4) {
        cashProductPrice = parseInt(cashProductPrice, 16);
      }

      if (cashProductId.length === 4) {
        cashProductId = parseInt(cashProductId, 16);
      }

      const productData = {
        vmcStatus,
        productPrice: cashProductPrice,
        productId: cashProductId,
      };

      log("CASH SALE DETECTED", productData);

      if (pythonSocket) {
        pythonSocket.emit("cash sale", productData);

        log("VMC -> PYTHON: cash sale", productData);
      } else {
        log("CASH SALE: Python is not connected");
      }
    }
  }

  // ==========================================================
  // Product Price - Multi Packet Response
  // ==========================================================

  if (
    priceCheck === true &&
    vmcChar !== "00" &&
    (vmcStatus === "running" || vmcStatus === "idleBit")
  ) {
    priceCheck = false;

    vmcPriceString += vmcChar;

    const startByte = vmcPriceString.slice(0, 4);

    // Collecting a command that started in idle (split across serial reads)
    if (vmcStatus === "idleBit") {
      // Not enough bytes yet to identify the command — keep waiting
      if (vmcPriceString.length < 4) {
        priceCheck = true;
        return;
      }

      // Command fully identified but it is not a product selection —
      // apply the same cancel handling as the idle guard
      if (startByte !== "1300") {
        log(
          `IDLE GUARD: Received ${startByte} instead of 1300, user likely cleared screen — resetting to enable`,
        );

        const result = checksum([0x07]);
        writeMdb(result, "VMC IDLE CANCEL ACK");

        setVmcStatus("enable");
        return;
      }
    }

    if (startByte === "1300") {
      // Only parse once the complete command has arrived
      // (14 chars normally, 18 when the price field is 0000)
      if (vmcPriceString.length < 14) {
        priceCheck = true;
        return;
      }

      if (vmcPriceString.slice(4, 8) === "0000" && vmcPriceString.length < 18) {
        priceCheck = true;
        return;
      }

      if (vmcStatus === "idleBit") {
        setVmcStatus("running");
      }

      productPriceHex = vmcPriceString.slice(4, 8);
      productId = vmcPriceString.slice(8, 12);

      if (productPriceHex.length === 4) {
        productPrice = parseInt(productPriceHex, 16);
      }

      if (productId.length === 4) {
        productId = parseInt(productId, 16);
      }

      if (productPriceHex === "0000") {
        productPriceHex = vmcPriceString.slice(8, 12);
        productId = vmcPriceString.slice(12, 16);

        if (productPriceHex.length === 4) {
          productPrice = parseInt(productPriceHex, 16);
        }

        if (productId.length === 4) {
          productId = parseInt(productId, 16);
        }
      }

      vmcPriceString = "";

      const productData = {
        productPrice,
        productId,
        vmcStatus,
      };

      log("PRODUCT SELECTED", productData);

      if (pythonSocket) {
        pythonSocket.emit("product price", productData);

        log("VMC -> PYTHON: product price", productData);
      } else {
        log("PRODUCT SELECTED: Python is not connected");
      }
    }
  }

  // ==========================================================
  // Drop Sensor
  // ==========================================================

  if (dropSensor === true && vmcChar !== "00" && vmcStatus === "approvedBit") {
    dropSensor = false;

    dropSensorString += vmcChar;

    const startByte = dropSensorString.slice(0, 4);

    if (startByte === "1302") {
      const result = checksum([0x07]);

      writeMdb(result, "VMC VEND COMPLETE ACK");

      setVmcStatus("complete");

      emitVendResult("success", "1302");

      priceCheck = false;
      dropSensor = false;
      productPrice = "0";
    } else if (startByte === "1303") {
      const result = checksum([0x07]);

      writeMdb(result, "VMC CASH VEND ACK");

      setVmcStatus("cash");

      emitVendResult("not_dispensed", "1303");

      priceCheck = false;
      dropSensor = false;
      productPrice = "0";
    }
  }

  // ==========================================================
  // Process End
  // ==========================================================

  if (processEnd === true && vmcChar !== "00" && vmcStatus === "completeBit") {
    processEnd = false;

    processEndString += vmcChar;

    const startByte = processEndString.slice(0, 4);

    if (startByte === "1304") {
      setVmcStatus("enable");

      const result = checksum([0x07]);

      writeMdb(result, "VMC PROCESS END ACK");
    }
  }

  // ==========================================================
  // Initial Connection / Idle
  // ==========================================================

  if (vmcChar.includes("00") && vmcStatus === "connect") {
    setVmcStatus("idle");
  }

  // ==========================================================
  // MDB 13 Response
  // ==========================================================
  else if (vmcChar.includes("13")) {
    // --------------------------------------------------------
    // Machine Idle -> Product Selection
    // --------------------------------------------------------

    if (vmcStatus === "idle") {
      vmcPriceString = "";

      const collectedString = vmcChar.substring(vmcChar.indexOf("13"));

      const stringLength = collectedString.length;
      const startByte = collectedString.slice(0, 4);

      // Split packet: fragment is shorter than the 4-char command code
      // (e.g. "130" in one read, "0..." in the next). Move to idleBit and
      // collect the rest before deciding — the guard must not fire yet.
      if (stringLength < 4) {
        setVmcStatus("idleBit");
        priceCheck = true;
        vmcPriceString += collectedString;
        return;
      }

      // Guard: Only accept product selection (1300) in idle state.
      // Any other command (e.g., 1304 process end from user clearing screen)
      // means the machine left the product selection screen — ACK and reset.
      if (startByte !== "1300") {
        log(
          `IDLE GUARD: Received ${startByte} instead of 1300, user likely cleared screen — resetting to enable`,
        );

        const result = checksum([0x07]);
        writeMdb(result, "VMC IDLE CANCEL ACK");

        setVmcStatus("enable");
        return;
      }

      setVmcStatus("running");

      if (stringLength < 14) {
        priceCheck = true;

        vmcPriceString += collectedString;
      } else {
        if (startByte === "1300") {
          productPriceHex = collectedString.slice(4, 8);
          productId = collectedString.slice(8, 12);

          if (productPriceHex.length === 4) {
            productPrice = parseInt(productPriceHex, 16);
          }

          if (productId.length === 4) {
            productId = parseInt(productId, 16);
          }

          if (productPriceHex === "0000") {
            if (stringLength < 18) {
              priceCheck = true;

              vmcPriceString += collectedString;
            } else {
              productPriceHex = collectedString.slice(8, 12);
              productId = collectedString.slice(12, 16);

              if (productPriceHex.length === 4) {
                productPrice = parseInt(productPriceHex, 16);
              }

              if (productId.length === 4) {
                productId = parseInt(productId, 16);
              }
            }
          }

          const productData = {
            productPrice,
            productId,
            vmcStatus,
          };

          log("PRODUCT SELECTED", productData);

          if (pythonSocket) {
            pythonSocket.emit("product price", productData);

            log("VMC -> PYTHON: product price", productData);
          } else {
            log("PRODUCT SELECTED: Python is not connected");
          }
        }
      }
    }

    // --------------------------------------------------------
    // Approved -> Vend Response
    // --------------------------------------------------------
    else if (vmcStatus === "approved") {
      setVmcStatus("approvedBit");

      const collectedString = vmcChar.substring(vmcChar.indexOf("13"));

      const stringLength = collectedString.length;

      if (stringLength < 4) {
        dropSensor = true;

        dropSensorString += collectedString;
      } else {
        const startByte = collectedString.slice(0, 4);

        if (startByte === "1302") {
          setVmcStatus("complete");

          emitVendResult("success", "1302");

          priceCheck = false;
          dropSensor = false;
          productPrice = "0";
        } else if (startByte === "1303") {
          setVmcStatus("cash");

          emitVendResult("not_dispensed", "1303");

          priceCheck = false;
          dropSensor = false;
          productPrice = "0";
        }
      }
    }

    // --------------------------------------------------------
    // Cash Sale
    // --------------------------------------------------------
    else if (
      vmcStatus === "enable" ||
      vmcStatus === "completeBit" ||
      vmcStatus === ""
    ) {
      setVmcStatus("cashSale");

      vmcCashString = "";

      const collectedString = vmcChar.substring(vmcChar.indexOf("13"));

      const stringLength = collectedString.length;

      if (stringLength < 18) {
        cashSaleCheck = true;

        vmcCashString += collectedString;
      } else {
        setVmcStatus("enable");

        const startByte = collectedString.slice(0, 4);

        if (startByte === "1305") {
          let cashProductPrice = collectedString.slice(8, 12);
          let cashProductId = collectedString.slice(12, 16);

          if (cashProductPrice.length === 4) {
            cashProductPrice = parseInt(cashProductPrice, 16);
          }

          if (cashProductId.length === 4) {
            cashProductId = parseInt(cashProductId, 16);
          }

          const productData = {
            vmcStatus,
            productPrice: cashProductPrice,
            productId: cashProductId,
          };

          log("CASH SALE DETECTED", productData);

          if (pythonSocket) {
            pythonSocket.emit("cash sale", productData);

            log("VMC -> PYTHON: cash sale", productData);
          } else {
            log("CASH SALE: Python is not connected");
          }
        }
      }
    }

    // --------------------------------------------------------
    // Transaction Complete / Cancel / Reject
    // --------------------------------------------------------
    else if (
      !vmcChar.includes("1303") &&
      !vmcChar.includes("1305") &&
      (vmcStatus === "cancel" ||
        vmcStatus === "complete" ||
        vmcStatus === "cash" ||
        vmcStatus === "rejected")
    ) {
      setVmcStatus("completeBit");

      const collectedString = vmcChar.substring(vmcChar.indexOf("13"));

      const stringLength = collectedString.length;

      if (stringLength < 4) {
        processEnd = true;

        processEndString += collectedString;
      } else {
        const startByte = collectedString.slice(0, 4);

        if (startByte === "1304") {
          setVmcStatus("enable");

          const result = checksum([0x07]);

          writeMdb(result, "VMC READY ACK");
        }
      }
    }

    // --------------------------------------------------------
    // Complete -> Cash Sale
    // --------------------------------------------------------
    else if (vmcStatus === "complete") {
      setVmcStatus("cashSale");
    }
  }
};

// ============================================================
// Server
// ============================================================

server.listen(port, () => {
  log(`NodeJS server listening on port ${port}`);
  log(
    `AUTO PURCHASE: ${autoPurchaseEnabled ? "ENABLED (timer-based purchase will run continuously)" : "DISABLED (manual button/socket triggers only)"}`,
  );
});

// ============================================================
// Serial Port Events
// ============================================================

serialPort.on("open", () => {
  log(`VMC serial port opened: ${serialPort.path}`);
});

serialPort.on("error", (error) => {
  log("VMC SERIAL ERROR", error.message);
});

serialPort.on("close", () => {
  log("VMC SERIAL PORT CLOSED");
});

// ============================================================
// Initial VMC Configuration
// ============================================================
//
// Same sequence as before: RESET after 5s, CONFIGURATION 3s later, then the
// AUTO_PURCHASE kick (see completeInitialization). Also reused by reset
// recovery so both paths initialize the cashless device identically.

setTimeout(() => {
  startInitialization("startup");
}, 5000);

// ============================================================
// Socket.IO - Python Communication
// ============================================================

io.on("connection", (socket) => {
  log(`Socket connected: ${socket.id}`);

  // ----------------------------------------------------------
  // Python POS Registration
  // ----------------------------------------------------------

  socket.on("register:python", () => {
    pythonSocket = socket;

    log(`[PYTHON] Python POS registered: ${socket.id}`);
  });

  // ----------------------------------------------------------
  // Simulator Registration
  // ----------------------------------------------------------

  socket.on("register:vmc-simulator", () => {
    vmcSimulatorSocket = socket;

    // This socket is the simulator, not Python
    if (pythonSocket?.id === socket.id) {
      pythonSocket = null;
    }

    log(`[SIM] VMC Simulator registered: ${socket.id}`);
  });

  // ----------------------------------------------------------
  // Purchase / Start Cashless Transaction
  // ----------------------------------------------------------

  socket.on("purchase now", () => {
    log("PYTHON -> VMC: Purchase requested");

    setVmcStatus("connect");

    const result = checksum([0x03, 0x03, 0xe8]);

    writeMdb(result, "VMC PURCHASE REQUEST");
  });

  // ----------------------------------------------------------
  // Start Purchase (guarded, Python-facing)
  // ----------------------------------------------------------

  socket.on("start purchase", () => {
    if (vmcStatus !== "" && vmcStatus !== "enable") {
      log(`PURCHASE BLOCKED: vmcStatus="${vmcStatus}"`);
      return;
    }

    log("PYTHON -> VMC: Purchase requested (guarded)");

    setVmcStatus("connect");

    const result = checksum([0x03, 0x03, 0xe8]);

    writeMdb(result, "VMC PURCHASE REQUEST");
  });

  // ----------------------------------------------------------
  // Approve Vend
  // ----------------------------------------------------------

  socket.on("approve vend", () => {
    log("PYTHON -> VMC: Approve vend");

    setVmcStatus("approved");

    const hexVar1 = parseInt("0x" + productPriceHex.substring(0, 2));

    const hexVar2 = parseInt("0x" + productPriceHex.substring(2, 4));

    productPriceHex = "";

    const approveArray = [0x05];

    approveArray.push(hexVar1);
    approveArray.push(hexVar2);

    const result = checksum(approveArray);

    writeMdb(result, "VMC APPROVE VEND");
  });

  // ----------------------------------------------------------
  // Reject Vend
  // ----------------------------------------------------------

  socket.on("reject vend", () => {
    log("PYTHON -> VMC: Reject vend");

    setVmcStatus("rejected");

    const result = checksum([0x06]);

    writeMdb(result, "VMC REJECT VEND");
  });

  // ----------------------------------------------------------
  // Cancel Vend
  // ----------------------------------------------------------

  socket.on("cancel vend", () => {
    log("PYTHON -> VMC: Cancel vend");

    setVmcStatus("cancel");

    const result = checksum([0x04]);

    writeMdb(result, "VMC CANCEL VEND");
  });

  // ----------------------------------------------------------
  // Enable Cash / Disable Cashless
  // ----------------------------------------------------------

  socket.on("cash on", () => {
    log("PYTHON -> VMC: Cash mode requested");
    runCashOnReset();
  });

  // ----------------------------------------------------------
  // Payment Result
  // ----------------------------------------------------------
  socket.on("pos payment result", (result) => {
    console.log("[POS] Payment result received:", result);

    if (result?.status === "approved") {
      console.log("[POS] Payment approved.");
    } else {
      console.log("[POS] Payment not approved:", result?.response);
    }
  });

  // ----------------------------------------------------------
  // Simulation Socket in place of vending machine
  // ----------------------------------------------------------
  socket.on("vmc raw", async (vmcChar) => {
    console.log(`[SIMULATOR] RX: ${vmcChar}`);

    await processVmcData(vmcChar);
  });

  // ----------------------------------------------------------
  // Disconnect
  // ----------------------------------------------------------

  socket.on("disconnect", () => {
    if (vmcSimulatorSocket?.id === socket.id) {
      vmcSimulatorSocket = null;

      log(`[SIM] VMC Simulator disconnected: ${socket.id}`);

      return;
    }

    if (pythonSocket?.id === socket.id) {
      pythonSocket = null;

      log(`[PYTHON] Python POS disconnected: ${socket.id}`);
    }
  });
});

// ============================================================
// Read Data From Vending Machine
// ============================================================

serialPort.on("readable", async () => {
  let vmcObj = await serialPort.read();

  if (vmcObj == null) {
    return;
  }

  const rawHex = vmcObj.toString("hex");
  const vmcChar = asciiToString(rawHex).trim();

  // Ignore empty responses
  if (!vmcChar) {
    return;
  }

  await processVmcData(vmcChar, rawHex);
});
