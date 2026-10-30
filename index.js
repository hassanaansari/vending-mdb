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
let handshakeTimer = null;

const IDLE_TIMEOUT_MS = 15000; // 15 seconds
const REJECTED_TIMEOUT_MS = 5000; // 5 seconds
const AUTO_PURCHASE_DELAY_MS = 4000; // 2 seconds delay before auto-purchase
const CONNECT_TIMEOUT_MS = 10000; // watchdog while waiting in "connect"
const HANDSHAKE_TIMEOUT_MS = 15000; // documented init handshake must complete in this time
const MAX_CONSECUTIVE_HANDSHAKE_FAILURES = 3; // then park in error state

// Initialization handshake state (see "Initialization Handshake" below)
let initializationInProgress = false;
let recoveryMode = false;
let vmcError = false;
let handshakeExhausted = false;
let handshakeStep = "not started";
let lastReceivedFrame = "none";
let consecutiveHandshakeFailures = 0;

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
  if (initializationInProgress || vmcError) {
    log("AUTO RESET: Skipped (initialization/error state)");
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
  if (initializationInProgress || vmcError) {
    log("AUTO PURCHASE: Skipped (initialization/error state)");
    return;
  }

  if (vmcStatus !== "" && vmcStatus !== "enable") {
    log(`AUTO PURCHASE: Skipped (vmcStatus="${vmcStatus}")`);
    return;
  }

  log("AUTO PURCHASE: Triggering purchase request");

  setVmcStatus("connect");

  const result = checksum([0x03, 0xff, 0xff]);
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
            lastReceivedFrame,
            status: vmcStatus,
          });

          failHandshake(
            "connection timeout: no valid VMC response to the purchase request",
          );
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
    if (initializationInProgress || vmcError) {
      log("AUTO PURCHASE: Suppressed (initialization/error state)");
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
    interpretation =
      "MDB ACK / adapter serial ACK (0x00) - acknowledges a frame, not readiness";
  } else if (command === 0x10) {
    interpretation =
      "MDB CASHLESS DEVICE 1 RESET: command byte 0x10 (device address 0x10 + command 0x00 RESET) + checksum 0x10";
  } else if (command === 0x11 && bytes[1] === 0x00) {
    interpretation = "VMC SETUP - CONFIG DATA (0x11 0x00)";
    if (bytes.length >= 6) {
      interpretation += `: VMC level=${bytes[2]} columns=${bytes[3]} rows=${bytes[4]} display=0x${bytes[5]
        .toString(16)
        .toUpperCase()
        .padStart(2, "0")}`;
    }
    if (bytes.length > 7) {
      interpretation += ` + ${bytes.length - 7} extra byte(s)`;
    }
  } else if (command === 0x11 && bytes[1] === 0x01 && bytes.length >= 6) {
    const maxPrice = (bytes[2] << 8) | bytes[3];
    const minPrice = (bytes[4] << 8) | bytes[5];
    interpretation = `VMC SETUP - MAX/MIN PRICE (0x11 0x01): max=${maxPrice} min=${minPrice} (0xFFFF/0x0000 = unknown)`;
  } else if (command === 0x11) {
    interpretation = "MDB SETUP (0x11) with unknown VMC data";
  } else if (command === 0x12) {
    interpretation =
      "MDB POLL (0x12) - answered automatically by the Pi2MDB adapter";
  } else if (command === 0x14 && bytes[1] === 0x01) {
    interpretation =
      "VMC READER ENABLE (0x14 0x01) - documented successful connection signal (140115)";
  } else if (command === 0x14 && bytes[1] === 0x02) {
    interpretation = "VMC READER CANCEL (0x14 0x02)";
  } else if (command === 0x14) {
    interpretation = "VMC READER DISABLE (0x14 0x00)";
  } else if (command === 0x17) {
    const subCommand = bytes[1] ?? 0x00;
    if (subCommand === 0x00) {
      interpretation =
        "VMC EXPANSION REQUEST ID (0x17 0x00) carrying the VMC identity";
    } else if (subCommand === 0x04) {
      interpretation = "VMC EXPANSION FEATURE ENABLE (0x17 0x04)";
    } else {
      interpretation = `MDB EXPANSION (0x17 sub-command 0x${subCommand
        .toString(16)
        .toUpperCase()
        .padStart(2, "0")})`;
    }

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
// Initialization Handshake (Pi2MDB adapter protocol)
// ============================================================
//
// Verified against the Pi2MDB converter manual (Wafer Microelectronics):
//  - "Adapter box will reply the poll command from VMC automatically."
//  - "When power on, Adapter box will reply the Config data that is saved in
//     the memory to VMC" (the host stores that data once with the 0x01 frame).
//  - "Any data from VMC except the poll command will be redirected to RS232
//     port" - SETUP/EXPANSION/READER/VEND/RESET reach the host for information.
//  - "Any data ... send ... together with checksum, then the adapter board
//     will send to VMC during the VMC poll request" - host frames are queued
//     and delivered as the next POLL response.
//  - "the adapter will reply you '00'" - a bare 00 is the adapter's serial ACK
//     of a host frame. It is NEVER initialization evidence.
//  - "If you can get the data 140115, Then ... PC2MDB adapter has successfully
//     connected to VMC" - READER ENABLE (14 01 15) IS the documented
//     initialization handshake completion.
//
// So the host must answer NONE of 0x11/0x12/0x14/0x17: the adapter owns those
// exchanges ("You don't need to do anythings"). The host's only initialization
// duty is to answer a VMC RESET (0x10) with JUST RESET (00 00 - the app's
// existing "VMC RESET" frame, which makes the VMC read the config data again)
// and to wait for 140115 before starting any session (03 03 E8 ...). Starting
// a session while the machine is still initializing is exactly what provoked
// the endless RESET loop.

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

  if (handshakeTimer) {
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
    log("HANDSHAKE TIMER: Cleared (VMC reset/recovery)");
  }
};

const noteLastFrame = (frameInfo) => {
  lastReceivedFrame = `${frameInfo.hex} (${frameInfo.interpretation})`;
};

const failHandshake = (reason) => {
  if (handshakeTimer) {
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }

  initializationInProgress = false;
  vmcError = true;
  consecutiveHandshakeFailures += 1;

  log("VMC INITIALIZATION FAILED", {
    reason,
    failedStep: handshakeStep,
    lastReceivedFrame,
    status: vmcStatus,
    consecutiveFailures: consecutiveHandshakeFailures,
  });

  if (recoveryMode) {
    recoveryMode = false;
    log("VMC RECOVERY COMPLETED", {
      outcome: "failed",
      failedStep: handshakeStep,
      lastReceivedFrame,
    });
  }

  if (consecutiveHandshakeFailures >= MAX_CONSECUTIVE_HANDSHAKE_FAILURES) {
    handshakeExhausted = true;
    log(
      "VMC INITIALIZATION FAILED: handshake attempts exhausted - no further automatic sessions will be started (restart the application to retry)",
    );
  }
};

const beginHandshake = (reason, isRecovery) => {
  if (initializationInProgress) {
    log(
      "VMC INITIALIZATION: Already waiting for READER ENABLE (140115) - no overlapping sequence started",
      reason,
    );
    return;
  }

  if (handshakeExhausted) {
    log(
      "VMC INITIALIZATION: Not started (handshake attempts exhausted)",
      reason,
    );
    return;
  }

  cancelObsoleteTimers();
  clearTransactionState();

  initializationInProgress = true;
  recoveryMode = isRecovery;
  vmcError = false;
  handshakeStep = "waiting for READER ENABLE (0x14 0x01 / '140115')";

  if (isRecovery) {
    log("VMC RECOVERY STARTED", { reason });
  }

  log("VMC INITIALIZATION STARTED", { reason });

  handshakeTimer = setTimeout(() => {
    handshakeTimer = null;
    failHandshake(
      `no READER ENABLE (140115) within ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
    );
  }, HANDSHAKE_TIMEOUT_MS);
};

const completeHandshake = (frameInfo) => {
  if (handshakeTimer) {
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
  }

  initializationInProgress = false;
  vmcError = false;
  handshakeExhausted = false;
  consecutiveHandshakeFailures = 0;
  handshakeStep = "complete (READER ENABLE 140115)";

  log("VMC INITIALIZATION COMPLETED", {
    evidence: frameInfo.hex,
    interpretation: frameInfo.interpretation,
  });
  log("VMC CASHLESS READY", {
    evidence:
      "READER ENABLE (140115) received - documented Pi2MDB/MDB handshake complete",
    lastReceivedFrame,
  });

  if (recoveryMode) {
    recoveryMode = false;
    log("VMC RECOVERY COMPLETED", {
      outcome: "success",
      evidence: frameInfo.hex,
    });
  }

  // Restore the enabled state; this re-arms the existing AUTO_PURCHASE behavior
  setVmcStatus("enable");
};

const handleVmcReset = (frameInfo) => {
  noteLastFrame(frameInfo);

  log("VMC RESET DETECTED", {
    hex: frameInfo.hex,
    interpretation: frameInfo.interpretation,
    checksum: describeChecksum(frameInfo),
    status: vmcStatus,
  });

  // Do not transmit 00 00 here.
  // The Pi2MDB manual does not identify 00 00 as the
  // command that asks the VMC to reread its saved config.

  if (initializationInProgress) {
    log("VMC RESET DETECTED: already waiting for READER ENABLE (140115)");
    return;
  }

  beginHandshake(`VMC reset cashless device 1 (${frameInfo.hex})`, true);
};
const handleVmcInitializationMessage = (frameInfo, frameBytes) => {
  noteLastFrame(frameInfo);

  log("VMC INITIALIZATION RESPONSE", {
    hex: frameInfo.hex,
    interpretation: frameInfo.interpretation,
    checksum: describeChecksum(frameInfo),
    status: vmcStatus,
  });

  // The Pi2MDB adapter answers POLL and the SETUP/config exchange by itself
  // ("You don't need to do anythings"). SETUP/POLL/EXPANSION/READER frames are
  // informational only and must not provoke host responses.

  if (frameBytes[0] === 0x14 && frameBytes[1] === 0x01) {
    // "If you can get the data 140115, Then ... successfully connected to VMC"
    if (!initializationInProgress) {
      beginHandshake(`VMC READER ENABLE (${frameInfo.hex})`, false);
    }
    completeHandshake(frameInfo);
    return;
  }

  if (!initializationInProgress && !handshakeExhausted) {
    beginHandshake(`VMC initialization command ${frameInfo.hex}`, false);
  }
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

    // VMC initialization commands (SETUP/POLL/READER/EXPANSION) - the Pi2MDB
    // adapter owns those exchanges; the host only logs/tracks them.
    if (
      frameBytes.length >= 2 &&
      (command === 0x11 ||
        command === 0x12 ||
        command === 0x14 ||
        command === 0x17)
    ) {
      handleVmcInitializationMessage(
        describeMdbFrame(frameBytes, payload),
        frameBytes,
      );
      return;
    }

    // ACK (0x00) and VEND traffic (0x13) keep the existing handling below.
    // A bare 00 is only the adapter's serial ACK of our last TX - it is never
    // readiness evidence and must not advance the initialization state.
    if (command === 0x00) {
      if (initializationInProgress) {
        log(
          "VMC INITIALIZATION RESPONSE: adapter ACK (0x00) - frame acknowledgement only, not readiness evidence",
        );
      }
    } else if (command === 0x13) {
      lastReceivedFrame = `${payload.toUpperCase()} (VMC VEND/transaction frame)`;
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
// The Pi2MDB adapter reports the config data saved in its memory to the VMC.
// This boot sequence keeps the existing behavior (JUST RESET + CONFIG DATA
// write at 5s/8s) but declares nothing ready: AUTO_PURCHASE starts only after
// "VMC CASHLESS READY", i.e. after the documented READER ENABLE (140115).

beginHandshake("startup", false);

// setTimeout(() => {
//   writeMdb(checksum([0x00]), "VMC INITIALIZATION COMMAND (JUST RESET)");
// }, 5000);

setTimeout(() => {
  writeMdb(
    checksum([0x01, 0x03, 0x15, 0x86, 0x01, 0x00, 0x05, 0x0c]),
    "VMC INITIALIZATION COMMAND (CONFIG DATA)",
  );
}, 8000);

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
    if (initializationInProgress || vmcError) {
      log("PURCHASE BLOCKED: initialization/error state");
      return;
    }

    log("PYTHON -> VMC: Purchase requested");

    setVmcStatus("connect");

    const result = checksum([0x03, 0xff, 0xff]);

    writeMdb(result, "VMC PURCHASE REQUEST");
  });

  // ----------------------------------------------------------
  // Start Purchase (guarded, Python-facing)
  // ----------------------------------------------------------

  socket.on("start purchase", () => {
    if (initializationInProgress || vmcError) {
      log("PURCHASE BLOCKED: initialization/error state");
      return;
    }

    if (vmcStatus !== "" && vmcStatus !== "enable") {
      log(`PURCHASE BLOCKED: vmcStatus="${vmcStatus}"`);
      return;
    }

    log("PYTHON -> VMC: Purchase requested (guarded)");

    setVmcStatus("connect");

    const result = checksum([0x03, 0xff, 0xff]);

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
