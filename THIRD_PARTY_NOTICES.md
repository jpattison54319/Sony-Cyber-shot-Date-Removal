# Third-party notices

The Git repository does not contain model weights. Release builds download the
pinned original model, verify its SHA-256, and include it in the installer.

| Component | Purpose | License |
| --- | --- | --- |
| [LaMa](https://github.com/advimman/lama) | Masked image reconstruction and distributed model weights | Apache License 2.0 |
| [simple-lama-inpainting](https://github.com/enesmsahin/simple-lama-inpainting) | Python wrapper for the fixed LaMa TorchScript model | Apache License 2.0 |
| [PyTorch](https://github.com/pytorch/pytorch) | Local model inference | BSD 3-Clause |
| [PySide6 Essentials / Qt for Python](https://doc.qt.io/qtforpython-6/licenses.html) | Desktop interface | LGPLv3 / GPLv3 / commercial |
| [NumPy](https://github.com/numpy/numpy) | Image array processing | BSD 3-Clause |
| [SciPy](https://github.com/scipy/scipy) | Detection and image operations | BSD 3-Clause |
| [Pillow](https://github.com/python-pillow/Pillow) | Image decoding and lossless PNG output | HPND |
| [OpenCV](https://github.com/opencv/opencv-python) | Original LaMa input preparation | Apache License 2.0 |
| [PyInstaller](https://pyinstaller.org/en/stable/license.html) | Native application packaging | GPL 2.0-or-later with bootloader exception |
| [Next.js](https://github.com/vercel/next.js) | Static installer website | MIT |
| [React](https://github.com/facebook/react) | Website interface runtime | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | Website interface icons | ISC |

The root MIT license covers this project's original source. It does not replace
third-party license terms. The supplied Python reference keeps its own license
and notice files under `reference/python-workflow/`.
