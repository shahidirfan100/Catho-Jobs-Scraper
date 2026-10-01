// Catho Jobs Scraper - Fast, reliable, HTTP-only extraction
// Listing HTML (offer ids) + per-offer detail JSON endpoint.
// Uses impit with a real browser TLS/HTTP fingerprint and Brazil residential proxy.
import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { Impit } from 'impit';

const BASE_URL = 'https://www.catho.com.br/vagas/';
const BASE_ORIGIN = 'https://www.catho.com.br';
const OFFER_DETAIL_URL = (id) => `https://oferta.catho.com.br/offer/${id}/d/j?ipo=42&iapo=1`;
const SUGGESTER_LOCATION_URL = 'https://www.catho.com.br/suggester/getlocationdata/';
const PAGE_SIZE = 20; // Catho shows 20 offers per listing page
const MAX_CONCURRENCY = 6; // parallel detail requests
const RETRY_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 45000;

const STATE_ABBREVS = ['sp', 'rj', 'mg', 'ba', 'pr', 'rs', 'sc', 'go', 'df', 'ce', 'pe', 'pa', 'ma', 'mt', 'ms', 'es', 'pb', 'rn', 'al', 'se', 'pi', 'am', 'ro', 'ac', 'ap', 'rr', 'to'];

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Convert text to URL-safe slug (e.g., "São Paulo" -> "sao-paulo")
const normalizeToSlug = (text) => {
    if (!text) return '';
    return text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except hyphens
        .trim()
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-'); // Collapse multiple hyphens
};

// Normalize text for comparison (remove accents, lowercase, trim)
const normalizeForComparison = (text) => {
    if (!text) return '';
    return text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/-/g, ' ') // Convert hyphens to spaces (for URL slugs)
        .replace(/[^a-z0-9\s,]/g, '') // Keep letters, numbers, spaces, commas
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .trim();
};

// Check if job location matches the requested location
const matchesRequestedLocation = (jobLocation, requestedLocation) => {
    if (!requestedLocation) return true; // No filter requested
    if (!jobLocation) return true; // Keep item when source has no location details

    const jobNorm = normalizeForComparison(jobLocation);
    const reqNorm = normalizeForComparison(requestedLocation);

    // Extract city name from request (handle formats like "sao-paulo-sp", "São Paulo, SP", "sp/sao-paulo")
    const statePattern = /,?\s*(sp|rj|mg|ba|pr|rs|sc|go|df|ce|pe|pa|ma|mt|ms|es|pb|rn|al|se|pi|am|ro|ac|ap|rr|to)\s*$/i;
    const statePrefixPattern = /^(sp|rj|mg|ba|pr|rs|sc|go|df|ce|pe|pa|ma|mt|ms|es|pb|rn|al|se|pi|am|ro|ac|ap|rr|to)\s+/i;

    const reqCity = reqNorm
        .replace(statePattern, '') // Remove state suffix
        .replace(statePrefixPattern, '') // Remove state prefix
        .trim();

    // Extract city from job location (usually "City, STATE" format)
    const jobCity = jobNorm.split(',')[0].trim();

    // Direct match
    if (jobCity === reqCity) return true;

    // Partial match (one contains the other)
    if (jobCity.includes(reqCity) || reqCity.includes(jobCity)) return true;

    // Word-by-word match (handles different word order)
    const reqWords = reqCity.split(' ').filter((w) => w.length > 2);
    const jobWords = jobCity.split(' ').filter((w) => w.length > 2);
    const matchedWords = reqWords.filter((w) => jobWords.includes(w));
    if (matchedWords.length >= Math.min(reqWords.length, jobWords.length) && matchedWords.length > 0) {
        return true;
    }

    return false;
};

// Build search URL using Catho's path-based structure.
// NOTE: the publication-date query parameter is lowercase `lastdays`.
const buildSearchUrl = ({ keyword, locationPath = '', locationQuery = '', page = 1, baseDirectUrl = null, lastDays = null }) => {
    let basePath;

    // If we have a direct URL (user-provided), use it with pagination only
    if (baseDirectUrl) {
        basePath = `${baseDirectUrl.replace(/\?.*$/, '').replace(/\/$/, '')}/`;
    } else {
        let path = BASE_URL;
        const keywordSlug = normalizeToSlug(keyword);

        // Catho URL patterns:
        // - /vagas/keyword/
        // - /vagas/keyword/city-state/
        // - /vagas/location/
        if (keywordSlug && locationPath) {
            path += `${keywordSlug}/${locationPath}/`;
        } else if (keywordSlug) {
            path += `${keywordSlug}/`;
        } else if (locationPath) {
            path += `${locationPath}/`;
        }
        basePath = path;
    }

    const queryParams = [];
    if (locationQuery) queryParams.push(locationQuery);
    if (page > 1) queryParams.push(`page=${page}`);
    if (lastDays !== null && lastDays !== 'anytime') queryParams.push(`lastdays=${lastDays}`);

    return queryParams.length > 0 ? `${basePath}?${queryParams.join('&')}` : basePath;
};

// Parse URL to extract search parameters from path-based URLs
const parseSearchUrl = (urlString) => {
    try {
        const url = new URL(urlString);
        const pathname = url.pathname.replace(/^\/vagas\/?/, '').replace(/\/$/, '');
        const segments = pathname.split('/').filter(Boolean);

        const keywordFromQuery = url.searchParams.get('q') || '';
        const page = parseInt(url.searchParams.get('page') || '1', 10);

        return {
            keyword: keywordFromQuery,
            location: '',
            page,
            pathSegments: segments,
            isDirectUrl: segments.length > 0,
        };
    } catch {
        return { keyword: '', location: '', page: 1, pathSegments: [], isDirectUrl: false };
    }
};

const pickFirst = (...values) => values.find((value) => value !== null && value !== undefined && String(value).trim() !== '');

const formatBrl = (value) => `R$ ${Number(value).toLocaleString('pt-BR')}`;

const formatSalary = (offer) => {
    const min = Number(offer?.smin) || 0;
    const max = Number(offer?.smax) || 0;
    if (min > 0 && max > 0 && max !== min) return `De ${formatBrl(min)} a ${formatBrl(max)}`;
    if (min > 0 && max > 0) return formatBrl(min);
    if (min > 0) return `A partir de ${formatBrl(min)}`;
    if (max > 0) return `Até ${formatBrl(max)}`;
    return pickFirst(offer?.sn) || null;
};

// --- Listing page extraction (fallback when a detail request is unavailable) ---

const parseListingCards = ($) => {
    const cards = [];

    $('li[data-offer-item]').each((_, element) => {
        const $li = $(element);
        const id = ($li.attr('data-offer-item') || '').trim() || null;

        const $anchor = $li.find('h2.title_offer a[data-navigation-offer]').first();
        const title = pickFirst($anchor.attr('title'), $anchor.text()) || null;
        if (!title) return;

        const href = $anchor.attr('href') || '';
        const url = href ? new URL(href, BASE_ORIGIN).href : null;

        const company = pickFirst($li.find('article.offer p.mb-2 span.text-12').first().text()) || null;

        let location = null;
        let vacancies = null;
        const $location = $li.find('span.i_job_location').first().parent();
        if ($location.length > 0) {
            const fullText = $location.text().replace(/\s+/g, ' ').trim();
            const strongText = $location.find('strong').first().text().replace(/\s+/g, ' ').trim();
            location = fullText.replace(strongText, '').replace(/^[\s\-–]+/, '').trim() || null;
            const vacancyMatch = strongText.match(/(\d+)/);
            vacancies = vacancyMatch ? Number(vacancyMatch[1]) : null;
        }

        let salary = null;
        let benefitsCount = null;
        const $salaryP = $li.find('span.i_salary').first().parent();
        if ($salaryP.length > 0) {
            salary = pickFirst($salaryP.find('strong').first().text()) || null;
            const benefitsMatch = $salaryP.text().match(/(\d+)\s*benef/i);
            benefitsCount = benefitsMatch ? Number(benefitsMatch[1]) : null;
        }

        const dateLabel = pickFirst($li.find('span.tag').first().text()) || null;
        const source = $li.find('input[data-type-offer-name]').attr('value') || null;

        cards.push({
            id,
            title,
            company,
            location,
            salary,
            employment_type: null,
            description: null,
            date_posted: dateLabel,
            url,
            apply_url: url,
            vacancies,
            benefits_count: benefitsCount,
            source,
        });
    });

    return cards;
};

// --- Detail JSON extraction ---

const mapDetailToRecord = (detail, fallback = {}) => {
    const offer = detail?.o || {};
    const company = detail?.c || {};

    const city = pickFirst(offer.cins?.[0]) || null;
    const state = pickFirst(offer.lab?.[0], offer.lns?.[0]) || null;
    const location = [city, state].filter(Boolean).join(', ') || fallback.location || null;

    let relativeUrl = null;
    if (offer.ur) {
        relativeUrl = offer.ur.startsWith('/') ? offer.ur : `/${offer.ur}`;
    }
    const url = relativeUrl ? `${BASE_ORIGIN}/vagas${relativeUrl}` : (fallback.url || null);

    return {
        id: String(pickFirst(offer.eoi, fallback.id) || ''),
        title: pickFirst(offer.t, offer.ltr, fallback.title) || null,
        company: pickFirst(company.cn, offer.cn, fallback.company) || null,
        location,
        salary: formatSalary(offer) || fallback.salary || null,
        employment_type: pickFirst(offer.lsj, offer.ctns?.[0], fallback.employment_type) || null,
        description: pickFirst(offer.ld, fallback.description) || null,
        date_posted: pickFirst(offer.dlu, offer.pt, offer.dluf, fallback.date_posted) || null,
        url,
        apply_url: url,
        source: fallback.source || 'catho',
        fetched_at: new Date().toISOString(),
    };
};

const mapWithConcurrency = async (items, limit, worker) => {
    const results = new Array(items.length);
    let cursor = 0;

    const run = async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
};

// --- Runtime ---

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        startUrl,
        keyword = '',
        location = '',
        lastDays: lastDaysInput = 'anytime',
        results_wanted: resultsWantedRaw = 20,
        proxyConfiguration,
    } = input;

    // Convert lastDays string to numeric value used by Catho's `lastdays` query param
    const lastDaysMap = {
        today: 0,
        '2days': 1,
        '3days': 2,
        week: 7,
        month: 30,
        anytime: null,
    };
    const lastDaysValue = lastDaysMap[lastDaysInput] !== undefined ? lastDaysMap[lastDaysInput] : null;

    const resultsWanted = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : 20;
    const maxPages = Math.ceil(resultsWanted / PAGE_SIZE) + 2; // Add buffer for duplicates/filtering

    // Country-matched residential proxy is required: Catho is behind a WAF that
    // rejects non-Brazilian datacenter traffic.
    let proxyConf;
    const hasCustomProxyUrls = Array.isArray(proxyConfiguration?.proxyUrls) && proxyConfiguration.proxyUrls.length > 0;
    if (hasCustomProxyUrls) {
        proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);
    } else if (proxyConfiguration?.useApifyProxy && Actor.isAtHome()) {
        proxyConf = await Actor.createProxyConfiguration({
            ...proxyConfiguration,
            apifyProxyCountry: proxyConfiguration.apifyProxyCountry || proxyConfiguration.countryCode || 'BR',
        });
    } else if (proxyConfiguration?.useApifyProxy && !Actor.isAtHome()) {
        log.warning('Local run detected: Apify Proxy is unavailable outside the Apify platform. Using a direct connection.');
    }

    const createClient = async () => {
        const proxyUrl = proxyConf ? await proxyConf.newUrl(`catho_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`) : undefined;
        return new Impit({
            browser: 'chrome',
            timeout: REQUEST_TIMEOUT_MS,
            ...(proxyUrl && { proxyUrl }),
        });
    };

    let client = await createClient();

    const fetchText = async (url, { accept, referer, method, body } = {}) => {
        for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
            try {
                const headers = { 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' };
                if (accept) headers.accept = accept;
                if (referer) headers.referer = referer;

                const requestOptions = { headers };
                if (method) requestOptions.method = method;
                if (body !== undefined) {
                    requestOptions.body = body;
                    headers['content-type'] = 'application/json';
                }

                const response = await client.fetch(url, requestOptions);
                const text = await response.text();

                if (response.status === 200) return text;

                if ([403, 407, 429, 500, 502, 503, 504].includes(response.status)) {
                    log.warning(`HTTP ${response.status}. Rotating proxy session (attempt ${attempt}/${RETRY_ATTEMPTS}).`);
                    client = await createClient();
                    continue;
                }

                log.warning(`Unexpected HTTP ${response.status}.`);
                return null;
            } catch (error) {
                log.warning(`Request error: ${error.message}. Rotating proxy session (attempt ${attempt}/${RETRY_ATTEMPTS}).`);
                client = await createClient();
            }
        }
        return null;
    };

    const fetchListingHtml = async (url) => {
        const text = await fetchText(url, { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', referer: BASE_URL });
        if (!text) return null;
        // A real listing page always contains the results counter or offer cards.
        if (!/resultados/i.test(text) && !text.includes('data-offer-item')) {
            log.warning(`Listing response did not look like a search page (len=${text.length}).`);
            return null;
        }
        return text;
    };

    const fetchOfferDetail = async (id) => {
        const text = await fetchText(OFFER_DETAIL_URL(id), { accept: 'application/json, text/plain, */*', referer: BASE_ORIGIN });
        if (!text) return null;
        try {
            const parsed = JSON.parse(text);
            return parsed?.o ? parsed : null;
        } catch {
            return null;
        }
    };

    const enrichCards = async (cards) => mapWithConcurrency(cards, MAX_CONCURRENCY, async (card) => {
        if (!card.id) return { record: card, detailed: false };
        const detail = await fetchOfferDetail(card.id);
        if (detail) return { record: mapDetailToRecord(detail, card), detailed: true };
        return { record: card, detailed: false };
    });

    // Resolve a free-text location ("São Paulo", "São Paulo, SP", "sp") into the
    // URL form Catho expects. City searches require the city-state slug ("sao-paulo-sp").
    const resolveLocation = async (rawLocation) => {
        const raw = rawLocation.trim();
        if (!raw) return { path: '', query: '', filter: '' };

        const ufOnly = raw.match(/^([a-zA-Z]{2})$/);
        if (ufOnly) return { path: ufOnly[1].toLowerCase(), query: '', filter: raw };

        const cityState = raw.match(/^(.+?)[,-]\s*([a-zA-Z]{2})$/);
        if (cityState) {
            return { path: `${normalizeToSlug(cityState[1])}-${cityState[2].toLowerCase()}`, query: '', filter: raw };
        }

        try {
            const responseText = await fetchText(SUGGESTER_LOCATION_URL, {
                method: 'POST',
                body: JSON.stringify(raw),
                accept: 'application/json',
                referer: BASE_URL,
            });
            const suggestions = responseText ? JSON.parse(responseText) : [];
            if (Array.isArray(suggestions) && suggestions.length > 0) {
                const normalizedRaw = normalizeForComparison(raw);
                const pick = suggestions.find((s) => s.type === 'city' && normalizeForComparison(s.name) === normalizedRaw)
                    || suggestions.find((s) => s.type === 'city')
                    || suggestions.find((s) => s.type === 'state')
                    || suggestions[0];
                if (pick?.type === 'city' && pick.urlSegment) {
                    const uf = (pick.stateUf || '').toLowerCase();
                    return { path: uf ? `${pick.urlSegment}-${uf}` : pick.urlSegment, query: '', filter: raw };
                }
                if (pick?.type === 'state' && pick.urlSegment) {
                    return { path: pick.urlSegment, query: '', filter: raw };
                }
                if (pick?.type === 'region' && pick.urlSegment) {
                    return { path: '', query: pick.urlSegment, filter: raw };
                }
            }
        } catch (error) {
            log.warning(`Location lookup failed for "${raw}": ${error.message}`);
        }

        return { path: normalizeToSlug(raw), query: '', filter: raw };
    };

    // Determine search parameters from startUrl or inputs
    let keywordValue = keyword.trim();
    const locationValue = location.trim();
    let startPage = 1;
    let directBaseUrl = null;
    let locationFilter = locationValue;

    if (startUrl && startUrl.includes('catho.com.br/vagas')) {
        directBaseUrl = startUrl;
        const parsed = parseSearchUrl(startUrl);
        if (parsed.keyword) keywordValue = parsed.keyword;
        if (parsed.page > 1) startPage = parsed.page;

        if (parsed.pathSegments.length > 0) {
            const segments = parsed.pathSegments;
            if (segments.length >= 2 && STATE_ABBREVS.includes(segments[0].toLowerCase())) {
                locationFilter = segments[1];
            } else if (segments.length >= 2) {
                locationFilter = segments[segments.length - 1];
            } else if (segments.length === 1) {
                const seg = segments[0];
                if (seg.match(/-(sp|rj|mg|ba|pr|rs|sc|go|df|ce|pe|pa|ma|mt|ms|es|pb|rn|al|se|pi|am|ro|ac|ap|rr|to)$/i)) {
                    locationFilter = seg;
                }
            }
            log.info(`Location filter: ${locationFilter}`);
        }
    } else if (locationValue) {
        locationFilter = locationValue;
    }

    let resolvedLocation = { path: '', query: '', filter: '' };
    if (!directBaseUrl && locationValue) {
        resolvedLocation = await resolveLocation(locationValue);
        log.info(`Resolved location: ${resolvedLocation.path || resolvedLocation.query || '(not resolved)'}`);
    }

    const seenIds = new Set();
    let saved = 0;
    let skippedLocationMismatch = 0;
    let detailsFetched = 0;
    const startTime = Date.now();
    const MAX_RUNTIME_MS = 5 * 60 * 1000; // 5 minute safety limit
    const stats = { pagesProcessed: 0, errors: 0 };
    let locationFallbackTried = false;

    log.info(`Starting Catho Jobs Scraper | keyword="${keywordValue || 'all'}" | location="${locationFilter || 'all'}" | date=${lastDaysInput} | target=${resultsWanted}`);

    for (let pageNum = startPage; pageNum <= maxPages && saved < resultsWanted; pageNum += 1) {
        if (Date.now() - startTime > MAX_RUNTIME_MS) {
            log.info('Runtime safety limit reached. Stopping pagination.');
            break;
        }

        const pageUrl = buildSearchUrl({
            keyword: keywordValue,
            locationPath: resolvedLocation.path,
            locationQuery: resolvedLocation.query,
            page: pageNum,
            baseDirectUrl: directBaseUrl,
            lastDays: lastDaysValue,
        });

        const html = await fetchListingHtml(pageUrl);
        if (!html) {
            stats.errors += 1;
            log.warning(`No usable listing HTML for page ${pageNum}. Stopping.`);
            break;
        }

        stats.pagesProcessed += 1;
        const $ = cheerio.load(html);
        const cards = parseListingCards($);

        if (cards.length === 0 && !locationFallbackTried && (resolvedLocation.path || resolvedLocation.query)) {
            locationFallbackTried = true;
            log.warning('No cards for the resolved location. Retrying without a location path and filtering client-side.');
            resolvedLocation = { path: '', query: '', filter: locationFilter };
            pageNum -= 1;
            continue;
        }

        if (cards.length === 0) {
            log.info(`No job cards found on page ${pageNum}. Stopping.`);
            break;
        }

        const remaining = resultsWanted - saved;
        const batch = cards.slice(0, remaining + 5); // small buffer for short/mismatched records

        const enriched = await enrichCards(batch);
        const records = [];
        for (const entry of enriched) {
            if (entry.detailed) detailsFetched += 1;
            records.push(entry.record);
        }

        const toSave = [];
        for (const record of records) {
            if (saved + toSave.length >= resultsWanted) break;

            const normalized = {
                ...record,
                id: pickFirst(record.id, record.url) ? String(pickFirst(record.id, record.url)) : null,
                fetched_at: record.fetched_at || new Date().toISOString(),
                source: record.source || 'catho',
            };
            if (!normalized.title || !normalized.id) continue;

            const dedupeKey = normalized.id;
            if (seenIds.has(dedupeKey)) continue;

            if (locationFilter && !matchesRequestedLocation(normalized.location, locationFilter)) {
                skippedLocationMismatch += 1;
                continue;
            }

            seenIds.add(dedupeKey);
            toSave.push(normalized);
        }

        if (toSave.length > 0) {
            await Actor.pushData(toSave);
            saved += toSave.length;
            log.info(`Page ${pageNum}: +${toSave.length} (${saved}/${resultsWanted})`);
        }

        if ($('a.next-page[href]').length === 0) break;

        await sleep(300);
    }

    const totalTime = (Date.now() - startTime) / 1000;

    log.info(`Done: ${saved}/${resultsWanted} jobs | ${stats.pagesProcessed} pages | ${detailsFetched} details | ${skippedLocationMismatch} skipped | ${stats.errors} errors | ${totalTime.toFixed(1)}s`);

    if (saved === 0) {
        const warningMsg = 'No jobs extracted. The search may have no matching listings, or the proxy did not return data.';
        log.warning(warningMsg);
        await Actor.setStatusMessage(warningMsg, { isStatusMessageTerminal: true });
        await Actor.setValue('OUTPUT_SUMMARY', {
            jobsSaved: 0,
            pagesProcessed: stats.pagesProcessed,
            runtime: totalTime,
            success: false,
        });
    } else {
        log.info(`SUCCESS: ${saved} job(s) saved to dataset.`);
        await Actor.setValue('OUTPUT_SUMMARY', {
            jobsSaved: saved,
            pagesProcessed: stats.pagesProcessed,
            runtime: totalTime,
            success: true,
        });
    }
} catch (error) {
    log.error(`CRITICAL ERROR: ${error.message}`);
    log.exception(error, 'Actor failed with exception');
    await Actor.fail(`Actor failed: ${error.message}`);
} finally {
    await Actor.exit();
}
