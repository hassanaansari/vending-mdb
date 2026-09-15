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

const IDLE_TIMEOUT_MS = 15000; // 15 seconds
const REJECTED_TIMEOUT_MS = 5000; // 5 seconds
const AUTO_PURCHASE_DELAY_MS = 4000; // 2 seconds delay before auto-purchase

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
      }, 1000);
    }, 1000);
  }, 1000);
};

const triggerAutoPurchase = () => {
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
  if (vmcStatus === "idle" && status !== "idle") {
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

  // Start idle timeout when entering idle status
  if (status === "idle" && !idleTimeoutTimer) {
    log(`IDLE TIMER: Starting ${IDLE_TIMEOUT_MS / 1000}s timeout`);
    idleTimeoutTimer = setTimeout(() => {
      if (vmcStatus === "idle") {
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

  // Auto-purchase: trigger purchase when returning to enable/empty status
  if ((status === "" || status === "enable") && !autoPurchaseTimer) {
    if (autoPurchaseEnabled) {
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

  if (priceCheck === true && vmcChar !== "00" && vmcStatus === "running") {
    priceCheck = false;

    vmcPriceString += vmcChar;

    const startByte = vmcPriceString.slice(0, 4);

    if (startByte === "1300") {
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

setTimeout(() => {
  // Reset
  const result = checksum([0x00]);

  writeMdb(result, "VMC RESET");

  setTimeout(() => {
    // Configuration Data
    const configResult = checksum([
      0x01, 0x03, 0x15, 0x86, 0x01, 0x00, 0x05, 0x0c,
    ]);

    writeMdb(configResult, "VMC CONFIGURATION");

    // Kick auto-purchase after initial boot if enabled
    if (autoPurchaseEnabled && (vmcStatus === "" || vmcStatus === "enable")) {
      log("AUTO PURCHASE: Initial boot complete, starting first cycle");
      setVmcStatus(vmcStatus); // re-enter current status to trigger timer
    }
  }, 30000);
}, 35000);

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
