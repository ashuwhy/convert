import handler_ImageMagick from "./handlers/ImageMagick.js";
import handler_FFmpeg from "./handlers/FFmpeg.js";
import handler_canvg from "./handlers/canvg.js";
import handler_imageToSVG from "./handlers/imageToSVG.js";
import handler_pdftoimg from "./handlers/pdftoimg.js";
import handler_rename from "./handlers/rename.js";

const handlers = [
  handler_ImageMagick,
  handler_FFmpeg,
  handler_canvg,
  handler_imageToSVG,
  handler_pdftoimg,
  handler_rename
];

let selectedFile;

const fileInput = document.querySelector("#file-input");
const fileSelectArea = document.querySelector("#file-area");
const convertButton = document.querySelector("#convert-button");

const inputList = document.querySelector("#from-list");
const outputList = document.querySelector("#to-list");
const inputSearch = document.querySelector("#search-from");
const outputSearch = document.querySelector("#search-to");

const searchHandler = function (event) {
  const string = event.target.value.toLowerCase();
  const list = event.target.parentElement.querySelector(".format-list");
  for (const button of Array.from(list.children)) {
    if (!button.textContent.toLowerCase().includes(string)) {
      button.style.display = "none";
    } else {
      button.style.display = "";
    }
  }
};

inputSearch.oninput = searchHandler;
outputSearch.oninput = searchHandler;

window.selectFile = function () {
  fileInput.click();
};

const fileSelectHandler = function (event) {

  let file;

  if ("dataTransfer" in event) {
    const item = event.dataTransfer?.items?.[0];
    if (item.kind !== "file") return;
    event.preventDefault();
    file = item.getAsFile();
  } else {
    file = event.target.files?.[0];
  }

  if (!file) return;
  selectedFile = file;

  fileSelectArea.innerHTML = `<h2>${file.name}</h2>`;

  const mimeType = file.type;
  const fileExtension = file.name.split(".").pop()

  inputSearch.value = mimeType || fileExtension;
  searchHandler({ target: inputSearch });

  if (!mimeType) return;

  for (const button of Array.from(inputList.children)) {
    if (button.getAttribute("mime-type") === mimeType) {
      button.click();
      break;
    }
  }

};

fileInput.addEventListener("change", fileSelectHandler);
window.addEventListener("drop", fileSelectHandler);
window.addEventListener("dragover", (e) => e.preventDefault());

const popupBox = document.querySelector("#popup");
const popupBackground = document.querySelector("#popup-bg");

function showPopup (html) {
  popupBox.innerHTML = html;
  popupBox.style.display = "block";
  popupBackground.style.display = "block";
}
function hidePopup () {
  popupBox.style.display = "none";
  popupBackground.style.display = "none";
}

const initPromises = [];
for (const handler of handlers) {
  initPromises.push(handler.init());
}

const allOptions = [];
// Expose globally for debugging
window.allSupportedFormats = allOptions;

Promise.all(initPromises).then(() => {

  for (const handler of handlers) {
    for (const format of handler.supportedFormats) {

      if (!format.mime) continue;

      allOptions.push({ format, handler });

      const newOption = document.createElement("button");
      newOption.setAttribute("format-index", allOptions.length - 1);
      newOption.setAttribute("mime-type", format.mime);
      newOption.appendChild(document.createTextNode(format.name + ` (${format.mime}) ${handler.name}`));

      const clickHandler = (event) => {
        const previous = event.target.parentElement.getElementsByClassName("selected")?.[0];
        if (previous) previous.className = "";
        event.target.className = "selected";
        const allSelected = document.getElementsByClassName("selected");
        if (allSelected.length === 2) {
          convertButton.className = "";
        } else {
          convertButton.className = "disabled";
        }
      };

      if (format.from) {
        const clone = newOption.cloneNode(true);
        clone.onclick = clickHandler;
        inputList.appendChild(clone);
      }
      if (format.to) {
        const clone = newOption.cloneNode(true);
        clone.onclick = clickHandler;
        outputList.appendChild(clone);
      }

    }
  }

  searchHandler({ target: inputSearch });
  searchHandler({ target: outputSearch });

  hidePopup();

});

async function attemptConvertPath (file, path) {

  popupBox.innerHTML = `<h2>Finding conversion route...</h2>
    <p>Trying ${path.map(c => c.format.format).join(" -> ")}</p>`;

  for (let i = 0; i < path.length - 1; i ++) {
    try {
      file.bytes = await path[i + 1].handler.doConvert(file, path[i].format, path[i + 1].format);
      if (!file.bytes.length) throw "Output is empty.";
      file.name = file.name.split(".")[0] + "." + path[i + 1].format.extension;
    } catch (e) {
      // console.log(path.map(c => c.format.format));
      // console.error(path[i + 1].handler.name, `${path[i].format.format} -> ${path[i + 1].format.format}`, e);
      return null;
    }
  }

  return { file, path };

}

async function buildConvertPath (file, target, queue) {

  while (queue.length > 0) {
    const path = queue.shift();
    if (path.length > 5) continue;

    const previous = path[path.length - 1];

    // Check if the target supports parsing *from* the previous node's format
    if (target.handler.supportedFormats.some(c => c.mime === previous.format.mime && c.from)) {
      const attempt = await attemptConvertPath(file, path.concat(target));
      if (attempt) return attempt;
    }

    // Get handlers that support *taking in* the previous format
    // Note that this will of course exclude the target handler
    const validHandlers = handlers.filter(handler => (
      handler.supportedFormats.some(format => (
        format.mime === previous.format.mime &&
        format.from
      ))
    ));

    // Look for untested mime types among valid handlers and add to queue
    for (const handler of validHandlers) {
      for (const format of handler.supportedFormats) {
        if (!format.to) continue;
        if (!format.mime) continue;
        if (path.some(c => c.format === format)) continue;
        queue.push(path.concat({ format, handler }));
      }
    }
  }

  return null;

}

window.convertSelection = async function () {

  const inputFile = selectedFile;

  if (!inputFile) {
    return alert("Select an input file.");
  }

  const inputButton = document.querySelector("#from-list .selected");
  if (!inputButton) return alert("Specify input file format.");

  const outputButton = document.querySelector("#to-list .selected");
  if (!outputButton) return alert("Specify output file format.");

  const inputOption = allOptions[Number(inputButton.getAttribute("format-index"))];
  const outputOption = allOptions[Number(outputButton.getAttribute("format-index"))];

  try {

    const inputBuffer = await inputFile.arrayBuffer();
    const inputBytes = new Uint8Array(inputBuffer);

    const inputFileData = { name: inputFile.name, bytes: inputBytes };

    showPopup("<h2>Finding conversion route...</h2>");

    const output = await buildConvertPath(inputFileData, outputOption, [[inputOption]]);
    if (!output) return alert("Failed to find conversion route.");

    const outputFormat = outputOption.format;

    const blob = new Blob([output.file.bytes], { type: outputFormat.mime });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = output.file.name;
    link.click();

    alert(
      `Converted ${inputOption.format.format} to ${outputOption.format.format}!\n` +
      `Path used: ${output.path.map(c => c.format.format).join(" -> ")}`
    );

  } catch (e) {

    alert("Unexpected error while routing:\n" + e);

  }

  hidePopup();

}
