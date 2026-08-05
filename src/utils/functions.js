const axios = require("axios");

const asciiToString = (acsii) => {
  let hex = acsii.toString(); //force conversion
  let str = "";
  for (let i = 0; i < hex.length; i += 2)
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return str;
};

const checkInternetConnection = () => {
  return axios
    .get("https://www.google.com")
    .then(() => true)
    .catch(() => false);
};

module.exports = {
  asciiToString,
  checkInternetConnection,
};
