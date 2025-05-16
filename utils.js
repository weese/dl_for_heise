import fs from 'fs';
import path from 'path';
import { mkdirp } from 'mkdirp';
import puppeteer from 'puppeteer';
import { execFile } from 'child_process';
import { promisify } from 'util';

export async function downloadFile(client, url, outputPath, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.get(url, { responseType: 'stream' });

      await mkdirp(path.dirname(outputPath));
      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);
      return new Promise((resolve, reject) => {
        // check if file hast
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (error) {
      // remove file if it exists
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
      console.warn(`Attempt ${attempt} failed: ${error.message}`);
      if (error.response && error.response.status === 404) {
        console.error(`File not found: ${url}`);
        return 404;
      }
      if (attempt === maxRetries) throw error;
      await new Promise(res => setTimeout(res, 5000)); // Wait before retrying
    }
  }
}

export async function downloadPageAsPDF(jar, url, outputPath) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Get cookies for the domain
  const cookies = await new Promise((resolve, reject) => {
    jar.getCookies(url, { allPaths: true }, (err, cookies) => {
      if (err) reject(err);
      else resolve(cookies);
    });
  });

  // Convert to Puppeteer format
  const puppeteerCookies = cookies.map((c) => ({
    name: c.key,
    value: c.value,
    domain: c.domain.startsWith('.') ? c.domain.slice(1) : c.domain,
    path: c.path,
    expires: c.expires instanceof Date ? Math.floor(c.expires.getTime() / 1000) : -1,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite === 'strict' ? 'Strict' :
              c.sameSite === 'lax' ? 'Lax' :
              'None',
  }));

  // Set cookies in Puppeteer
  await page.setCookie(...puppeteerCookies);

  // Navigate to page
  await page.goto(url, { waitUntil: 'networkidle0' });

  // Save PDF
  await mkdirp(path.dirname(outputPath));
  await page.pdf({ path: outputPath, format: 'A4' });

  await browser.close();
}

const execFileAsync = promisify(execFile);
export async function mergePDFs(inputPaths, outputPath) {
  const args = [
    '-dBATCH',
    '-dNOPAUSE',
    '-q',
    '-sDEVICE=pdfwrite',
    `-sOutputFile=${outputPath}`,
    ...inputPaths
  ];

  try {
    await execFileAsync('gs', args);
    console.log(`Merged PDF saved to ${outputPath}`);
  } catch (err) {
    console.error('Ghostscript merge failed:', err);
    throw err;
  }
}
