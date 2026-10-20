# Contributing to Range Book

Thanks for helping. Bug reports, ideas and fixes are all welcome.

- **Bugs and ideas:** open an issue. Say what you did, what you expected and what happened, plus your Range Book version (bottom of the More menu) and your phone or browser. If you'd rather not post publicly, email **hello@rangebook.org**.
- **Security problems:** please don't open a public issue. Email them instead; see [SECURITY.md](SECURITY.md).
- **Code:** fork the repository, make your change on a branch and open a pull request against the **`dev`** branch. `main` holds the released version; work collects on `dev` and goes out together in the next release. Range Book has no build step and no npm packages: `server.js` is the server and `public/index.html` is the whole app; `export.js` (Excel and PDF), `backup.js` (backups and reading spreadsheets) and `merge.js` (combining saves from several devices) are small helpers the server uses. Run it locally with `PORT=9090 DATA_DIR=./data node server.js` (Node 22 or newer) and check your change on a phone-sized screen and a desktop, in the Light, Dark and Red Night themes.
- **Version notes:** add a plain-language line about your change to the top entry of `public/changelog.json`.
- **Never include real data.** No real loads, notes, photos or exports in issues, commits or screenshots. Use the built-in sample load and made-up gear (the README screenshots use an account called `demo`).

## License of contributions

Range Book is licensed under the GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later). By sending a contribution you agree that it's licensed under the same terms, and that you have the right to contribute it.

## Safety

Range Book is a notebook and a calculator, not a load manual. Please don't add or share load data as if it were published, tested data.
