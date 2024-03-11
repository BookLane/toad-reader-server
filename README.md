# Installation

1. `npm i` (using Node 14)
2. Copy .env-example to .env and update appropriately (DEV_NETWORK_IP for sure)
3. Create a MySQL database using `db_structure.sql` and `seeds.sql`
4. Change auto-increment for the `book` table to be some large number so as to not conflict with other devs (since the same aws s3 bucket is used)
5. Complete AWS setup (needed for import of epub or audiobook + testing emails)

(Unless emails need to be tested, you may simply log in with dev@toadreader.com, grabbing the login code from the logs.)

# Development

`npm start`

# Updating Staging

`npm run push-to-aws`

# Demo

[toadreader.com/demo](https://toadreader.com/demo/)

# License

[AGPL-3.0](https://opensource.org/licenses/AGPL-3.0) ([summary](https://tldrlegal.com/license/gnu-affero-general-public-license-v3-(agpl-3.0)))
