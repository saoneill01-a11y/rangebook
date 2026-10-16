Optional: offline chronograph import

The chronograph import (RangeCraft / Garmin files) uses a free spreadsheet reader
called SheetJS. By default the browser downloads it from cdnjs the first time you import.

If you'd rather not depend on the internet, download this file:
  https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
and save it in this folder as  xlsx.full.min.js  before building the Docker image.
The app checks here first and only falls back to cdnjs if it isn't found.
