# Installation

1. Copy .env-example to .env and update appropriately (DEV_NETWORK_IP for sure)
2. Create db - use db_structure.sql and seeds.sql
3. Change auto-increment for the `book` table to be some large number so as to not conflict with other devs (since the same aws s3 bucket is used)
4. AWS setup (needed for import of epub or audiobook + testing emails)

(Unless emails need to be tested, you may simply log in with dev@toadreader.com, grabbing the login code from the logs.)

# Demo

[toadreader.com/demo](https://toadreader.com/demo/)

# License

[AGPL-3.0](https://opensource.org/licenses/AGPL-3.0) ([summary](https://tldrlegal.com/license/gnu-affero-general-public-license-v3-(agpl-3.0)))
