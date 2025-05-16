import axios from 'axios';
import tough from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import fs, { stat, unlink } from 'fs';
import path from 'path';
import { program } from 'commander';
import chalk from 'chalk';
import { downloadFile } from './utils.js';
import dotenv from 'dotenv';

var jar = new tough.CookieJar();
var client = wrapper(axios.create({ jar }));


// Read credentials from environment variables or a .env file
dotenv.config();
if (!process.env.HEISE_USERNAME || !process.env.HEISE_PASSWORD) {
  console.error(chalk.red('Please set HEISE_USERNAME and HEISE_PASSWORD in your environment variables or .env file.'));
  process.exit(1);
}


async function login({ username, password, cookieJarPath }) {
  jar = new tough.CookieJar();
  client = wrapper(axios.create({ jar }));
  try {
    // Initial GET request to establish session
    console.log('Logging in...');
    await client.get('https://www.heise.de/sso/login');

    // POST request with credentials
    console.log('Fetching login page...');
    const response = await client.post(
      'https://www.heise.de/sso/login/login',
      new URLSearchParams({
        forward: '',
        username,
        password,
        ajax: '1',
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    // Extract tokens from response
    console.log('Processing login response...');

    // Complete login process
    for (const url of response.data.remote_login_urls) {
      console.log('Logging in to:', url.url, 'with token:', url.data.token);
      await client.post(
        url.url, 
        new URLSearchParams({
          token: url.data.token,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );
    }

    const json = await jar.serialize(); // `jar` is a tough-cookie CookieJar
    fs.writeFileSync(cookieJarPath, JSON.stringify(json));
    console.log('Login successful.');
  } catch (error) {
    console.error('Login failed:', error.message);
    process.exit(1);
  }
}


program
  .option('-v, --verbose', 'Enable verbose output')
  .argument('<magazine>', 'Magazine name (e.g., ct, ix)')
  .argument('<startYear>', 'Start year', parseInt)
  .argument('[endYear]', 'End year', parseInt)
  .parse(process.argv);

const options = program.opts();
const [magazine, startYear, endYear = startYear] = program.args;

(async () => {
  // if cookiejar.json does not exist, login
  if (!fs.existsSync('cookiejar.json')) {
    console.log(chalk.red('cookiejar.json not found. Logging in...'));
    await login({
      username: process.env.HEISE_USERNAME,
      password: process.env.HEISE_PASSWORD,
      cookieJarPath: 'cookiejar.json',
    });
  } else {
    jar = tough.CookieJar.deserializeSync(
      JSON.parse(fs.readFileSync('cookiejar.json', 'utf-8'))
    );
    client = wrapper(axios.create({ jar }));
  }

  for (let year = startYear; year <= endYear; year++) {
    for (let issue = 1; issue <= 10; issue++) {
      const issueStr = String(issue).padStart(2, '0');
      const basePath = path.join(magazine, String(year), `${magazine}.${year}.${issueStr}`);
      const pdfPath = `${basePath}.pdf`;

      if (fs.existsSync(pdfPath)) {
        if (options.verbose) console.log(chalk.yellow(`Skipping existing issue: ${pdfPath}`));
        continue;
      }

      try {
        // Download thumbnail
        const thumbUrl = `https://heise.cloudimg.io/v7/_www-heise-de_/select/thumbnail/${magazine}/${year}/${issue}.jpg`;
        const landingPage = `https://www.heise.de/select/${magazine}/archiv/${year}/${issue}`;
        if (await downloadFile(client, thumbUrl, `${basePath}.jpg`) == 404) {
          console.warn(chalk.red(`Thumbnail not found: ${basePath}.jpg`));
          // continue if also landing page doesn't exists
          if (await downloadFile(client, landingPage, "test.html") == 404) {
            continue;
          }
        }

        // Fetch article numbers
        const archiveUrl = `https://www.heise.de/select/${magazine}/archiv/${year}/${issue}/download`;
        for (let attempt = 1; attempt <= 10; attempt++) {
          await downloadFile(client, archiveUrl, pdfPath);
          const fileSize = fs.statSync(pdfPath).size;
          if (fileSize > 5000000) {
            break;
          }
          // remove file if it exists
          if (fs.existsSync(pdfPath)) {
            fs.unlinkSync(pdfPath);
          }
          console.warn(`Attempt ${attempt} failed: File size is too small (${fileSize} bytes). Retrying...`);
          await new Promise(res => setTimeout(res, 2000)); // Wait before retrying
          // await login({
          //   username,
          //   password,
          //   cookieJarPath: 'cookiejar.json',
          // });
        }

        console.log(chalk.green(`Downloaded issue: ${pdfPath}`));
      } catch (error) {
        console.error(chalk.red(`Failed to process issue ${year}/${issueStr}: ${error.message}`));
      }
    }
  }
})();
