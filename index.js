const express = require("express");
const app = express();
const server = require("http").createServer(app);
const io = require("socket.io")(server);
const port = process.env.PORT || 3000;

const { SerialPort } = require("serialport");
require("dotenv").config();

const { asciiToString } = require("./src/utils/functions");

// ============================================================
// Configuration
// ============================================================

const serialPort = new SerialPort({
  // Windows
  path: "COM3",

  // Raspberry Pi example:
  // path: "/dev/ttyAMA0",

  baudRate: 9600,
});

let pythonSocket = null;

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

const setVmcStatus = (status) => {
  if (vmcStatus !== status) {
    log(`VMC STATUS: ${vmcStatus || "INITIAL"} -> ${status}`);
  }

  vmcStatus = status;
};

const writeMdb = (buffer, description = "MDB command") => {
  log(`${description}: TX`, buffer.toString("hex").toUpperCase());

  serialPort.write(buffer, (error) => {
    if (error) {
      log(`${description}: WRITE ERROR`, error.message);
    }
  });
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
// Server
// ============================================================

server.listen(port, () => {
  log(`NodeJS server listening on port ${port}`);
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
  }, 5000);
}, 8000);

// ============================================================
// Socket.IO - Python Communication
// ============================================================

io.on("connection", (socket) => {
  pythonSocket = socket;

  log(`Python connected through Socket.IO: ${socket.id}`);

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

    setVmcStatus("enable");

    const result = checksum([0x06]);

    writeMdb(result, "VMC CASH MODE STEP 1");

    setTimeout(() => {
      const result = checksum([0x07]);

      writeMdb(result, "VMC CASH MODE STEP 2");

      setTimeout(() => {
        const result = checksum([0x06]);

        writeMdb(result, "VMC CASH MODE STEP 3");

        setTimeout(() => {
          const result = checksum([0x07]);

          writeMdb(result, "VMC CASH MODE STEP 4");

          log("VMC cash mode sequence completed");
        }, 1000);
      }, 1000);
    }, 1000);
  });

  // ----------------------------------------------------------
  // Disconnect
  // ----------------------------------------------------------

  socket.on("disconnect", () => {
    if (pythonSocket?.id === socket.id) {
      pythonSocket = null;
    }

    log(`Python disconnected: ${socket.id}`);
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

  // We don't need noisy logging for simple 00 responses.
  // Log meaningful MDB responses only.
  if (vmcChar !== "00") {
    log("VMC RX", {
      hex: rawHex.toUpperCase(),
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

      priceCheck = false;
      dropSensor = false;
      productPrice = "0";
    } else if (startByte === "1303") {
      const result = checksum([0x07]);

      writeMdb(result, "VMC CASH VEND ACK");

      setVmcStatus("cash");

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
      setVmcStatus("running");

      vmcPriceString = "";

      const collectedString = vmcChar.substring(vmcChar.indexOf("13"));

      const stringLength = collectedString.length;

      if (stringLength < 14) {
        priceCheck = true;

        vmcPriceString += collectedString;
      } else {
        const startByte = collectedString.slice(0, 4);

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

          priceCheck = false;
          dropSensor = false;
          productPrice = "0";
        } else if (startByte === "1303") {
          setVmcStatus("cash");

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
});
