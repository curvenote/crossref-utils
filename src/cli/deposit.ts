import path from 'node:path';
import fs from 'node:fs';
import { Command, Option } from 'commander';
import inquirer from 'inquirer';
import { v4 as uuid } from 'uuid';
import {
  Session,
  filterPages,
  findCurrentProjectAndLoad,
  getFileContent,
  loadConfig,
  loadProject,
  parseMyst,
  processProject,
  selectors,
} from 'myst-cli';
import type { ISession } from 'myst-cli';
import { clirun } from 'myst-cli-utils';
import type { GenericParent } from 'myst-common';
import { extractPart, plural } from 'myst-common';
import { JatsSerializer } from 'myst-to-jats';
import { VFile } from 'vfile';
import { u } from 'unist-builder';
import type { Element } from 'xast';
import { DoiBatch } from '../batch.js';
import { journalArticleFromMyst, journalXml } from '../journal.js';
import { preprintFromMyst } from '../preprint.js';
import { addDoiToConfig, element2JatsUnist, transformXrefToLink } from './utils.js';
import type { ProjectFrontmatter } from 'myst-frontmatter';
import { selectNewDois } from './generate.js';
import type { ConferenceOptions, JournalIssue } from '../types.js';
import { curvenoteDoiData } from '../utils.js';
import { conferencePaperFromMyst, conferenceXml } from '../conference.js';
import { contributorsXmlFromMystEditors } from '../contributors.js';

type DepositType = 'conference' | 'journal' | 'preprint';

type DepositOptions = {
  type?: DepositType;
  file?: string;
  id?: string;
  name?: string;
  email?: string;
  registrant?: string;
  output?: string;
  journalTitle?: string;
  journalAbbr?: string;
  journalDoi?: string;
  prefix?: string;
};

type DepositSource = {
  projectPath: string;
  depositFile: string;
};

export async function depositArticleFromSource(session: ISession, depositSource: DepositSource) {
  const { projectPath, depositFile } = depositSource;
  const state = session.store.getState();
  const configFile = selectors.selectLocalConfigFile(state, projectPath);
  const projectFrontmatter = selectors.selectLocalProjectConfig(
    session.store.getState(),
    projectPath,
  );
  let abstractPart: GenericParent | undefined;
  let frontmatter: ProjectFrontmatter | undefined;
  const dois: Record<string, string> = {};
  if (depositFile === configFile) {
    const { pages } = await loadProject(session, projectPath);
    const fileContents = await getFileContent(
      session,
      pages.map(({ file }) => file),
      { projectPath, imageExtensions: [] },
    );
    if (projectFrontmatter?.parts?.abstract) {
      abstractPart = parseMyst(session, projectFrontmatter.parts.abstract.join('\n\n'), configFile);
    } else {
      fileContents.forEach(({ mdast }) => {
        if (abstractPart) return;
        abstractPart = extractPart(mdast, 'abstract');
      });
    }
    fileContents.forEach(({ references }) => {
      references.cite?.order.forEach((key) => {
        const value = references.cite?.data[key].doi;
        if (value) dois[key] = value;
        else session.log.warn(`Citation without DOI excluded from crossref deposit: ${key}`);
      });
    });
    frontmatter = projectFrontmatter;
  } else {
    const [fileContent] = await getFileContent(session, [depositFile], {
      projectPath,
      imageExtensions: [],
    });
    // Prioritize project title over page title
    const title = projectFrontmatter?.title ?? frontmatter?.title;
    // Prioritize project subtitle over page subtitle unless project has no title
    const subtitle = projectFrontmatter?.title
      ? projectFrontmatter?.subtitle ?? undefined
      : frontmatter?.subtitle;
    frontmatter = { ...fileContent.frontmatter, title, subtitle };
    abstractPart = extractPart(fileContent.mdast, 'abstract');
    fileContent.references.cite?.order.forEach((key) => {
      const value = fileContent.references.cite?.data[key].doi;
      if (value) dois[key] = value;
      else session.log.warn(`Citation without DOI excluded from crossref deposit: ${key}`);
    });
  }

  let abstract: Element | undefined;
  if (abstractPart) {
    transformXrefToLink(abstractPart);
    const serializer = new JatsSerializer(new VFile(), abstractPart as any);
    const jats = serializer.render(true).elements();
    abstract = u(
      'element',
      { name: 'jats:abstract' },
      jats.map((e) => element2JatsUnist(e)),
    ) as Element;
  }
  return { frontmatter: frontmatter ?? {}, dois, abstract, configFile };
}

async function getDepositSources(
  session: ISession,
  opts: DepositOptions,
): Promise<DepositSource[]> {
  let depositFile: string;
  let projectPath: string | undefined;
  // If file is specified, find the containing project and use it as the only source
  if (opts.file) {
    depositFile = path.resolve(opts.file);
    projectPath = await findCurrentProjectAndLoad(session, depositFile);
    if (!projectPath) {
      throw new Error(`Unable to determine project path from file: ${opts.file}`);
    }
    return [{ depositFile, projectPath }];
  }
  // If file is not specified and there is a project on the current path, select a single source from there
  await session.reload();
  const state = session.store.getState();
  projectPath = selectors.selectCurrentProjectPath(state);
  const configFile = selectors.selectCurrentProjectFile(state);
  if (projectPath && configFile) {
    const project = await processProject(
      session,
      { path: projectPath },
      {
        imageExtensions: [],
        writeFiles: false,
      },
    );
    const pages = filterPages(project);
    if (pages.length === 0) throw new Error('No MyST pages found');
    const resp = await inquirer.prompt([
      {
        name: 'depositFile',
        type: 'list',
        message: 'File:',
        choices: [{ file: configFile }, ...filterPages(project)].map(({ file }) => {
          return { name: path.relative('.', file), value: file };
        }),
      },
    ]);
    depositFile = resp.depositFile;
    return [{ projectPath, depositFile }];
  }
  // If there is no project on the current path, load all projects in child folders
  const subdirs = fs
    .readdirSync('.')
    .map((item) => path.resolve(item))
    .filter((item) => fs.lstatSync(item).isDirectory());
  const depositSources = (
    await Promise.all(
      subdirs.map(async (dir) => {
        const config = await loadConfig(session, dir);
        if (!config) return;
        return {
          projectPath: dir,
          depositFile: selectors.selectLocalConfigFile(session.store.getState(), dir),
        };
      }),
    )
  ).filter((source): source is DepositSource => !!source);
  return depositSources;
}

function issueDataFromArticles(
  session: ISession,
  articles: { frontmatter: ProjectFrontmatter }[],
  opts: DepositOptions,
) {
  let { journalTitle, journalAbbr, journalDoi } = opts;
  let volume: string | undefined;
  let issue: string | undefined;
  let issueDoi: string | undefined;
  let publicationDate: Date | false | undefined;
  let journalSeries: string | undefined;
  let journalIssn: string | undefined;
  let eventNumber: string | number | undefined;
  let eventDate: string | undefined;
  let eventLocation: string | undefined;
  let proceedingsTitle: string | undefined;
  let proceedingsPublisher: string | undefined;
  let proceedingsSubject: string | undefined;
  let proceedingsEditors: Element | undefined;
  articles.forEach(({ frontmatter }) => {
    const { biblio, date, venue, editors } = frontmatter;
    if (venue?.title) {
      if (!journalTitle) {
        journalTitle = venue.title;
      } else if (journalTitle !== venue.title) {
        throw new Error(`Conflicting journal titles: "${journalTitle}" and "${venue.title}"`);
      }
    }
    if (venue?.short_title) {
      if (!journalAbbr) {
        journalAbbr = venue.short_title;
      } else if (journalAbbr !== venue.short_title) {
        throw new Error(
          `Conflicting journal abbreviations: "${journalAbbr}" and "${venue.short_title}"`,
        );
      }
    }
    if (venue?.doi) {
      if (!journalDoi) {
        journalDoi = venue.doi;
      } else if (journalDoi !== venue.doi) {
        throw new Error(`Conflicting journal dois: "${journalDoi}" and "${venue.doi}"`);
      }
    }
    if (venue?.series) {
      if (!journalSeries) {
        journalSeries = venue.series;
      } else if (journalSeries !== venue.series) {
        throw new Error(`Conflicting series: "${journalSeries}" and "${venue.series}"`);
      }
    }
    if (venue?.issn) {
      if (!journalIssn) {
        journalIssn = venue.issn;
      } else if (journalIssn !== venue.issn) {
        throw new Error(`Conflicting issn: "${journalIssn}" and "${venue.issn}"`);
      }
    }
    if (venue?.number != null) {
      if (!eventNumber) {
        eventNumber = venue.number;
      } else if (eventNumber !== venue.number) {
        throw new Error(`Conflicting event number: "${eventNumber}" and "${venue.number}"`);
      }
    }
    if (venue?.date != null) {
      if (!eventDate) {
        eventDate = venue.date;
      } else if (eventDate !== venue.date) {
        throw new Error(`Conflicting event date: "${eventDate}" and "${venue.date}"`);
      }
    }
    if (venue?.location != null) {
      if (!eventLocation) {
        eventLocation = venue.location;
      } else if (eventLocation !== venue.location) {
        throw new Error(`Conflicting event location: "${eventLocation}" and "${venue.location}"`);
      }
    }
    if (venue?.publisher != null) {
      if (!proceedingsPublisher) {
        proceedingsPublisher = venue.publisher;
      } else if (proceedingsPublisher !== venue.publisher) {
        throw new Error(
          `Conflicting proceedings publisher: "${proceedingsPublisher}" and "${venue.publisher}"`,
        );
      }
    }
    if (biblio?.volume) {
      if (!volume) {
        volume = String(biblio.volume);
      } else if (volume !== String(biblio.volume)) {
        throw new Error(`Conflicting volumes: "${volume}" and "${biblio.volume}"`);
      }
    }
    if (biblio?.issue) {
      if (!issue) {
        issue = String(biblio.issue);
      } else if (issue !== String(biblio.issue)) {
        throw new Error(`Conflicting issues: "${issue}" and "${biblio.issue}"`);
      }
    }
    if (biblio?.doi) {
      if (!issueDoi) {
        issueDoi = biblio.doi;
      } else if (issueDoi !== biblio.doi) {
        throw new Error(`Conflicting issue dois: "${issueDoi}" and "${biblio.doi}"`);
      }
    }
    if (biblio?.title) {
      if (!proceedingsTitle) {
        proceedingsTitle = biblio.title;
      } else if (proceedingsTitle !== biblio.title) {
        throw new Error(
          `Conflicting proceedings titles: "${proceedingsTitle}" and "${biblio.title}"`,
        );
      }
    }
    if (biblio?.subject) {
      if (!proceedingsSubject) {
        proceedingsSubject = biblio.subject;
      } else if (proceedingsSubject !== biblio.subject) {
        throw new Error(
          `Conflicting proceedings subjects: "${proceedingsSubject}" and "${biblio.subject}"`,
        );
      }
    }
    if (date) {
      const articleDate = new Date(date);
      if (publicationDate == null) {
        publicationDate = articleDate;
      } else if (publicationDate && publicationDate.getTime() !== articleDate.getTime()) {
        publicationDate = false;
      }
    }
    if (editors?.length && !proceedingsEditors) {
      proceedingsEditors = contributorsXmlFromMystEditors(frontmatter);
    }
  });
  if (!publicationDate && (volume || issue || issueDoi)) {
    throw new Error(
      'if volume/issue/issueDoi are provided, all articles must have the same publication date',
    );
  }
  return {
    journalTitle,
    journalDoi,
    journalAbbr,
    volume,
    issue,
    issueDoi,
    publicationDate,
    journalSeries,
    journalIssn,
    eventNumber,
    eventDate,
    eventLocation,
    proceedingsTitle,
    proceedingsPublisher,
    proceedingsSubject,
    proceedingsEditors,
  };
}

export async function deposit(session: ISession, opts: DepositOptions) {
  let { type: depositType, name, email, registrant, prefix } = opts;
  if (!depositType) {
    const resp = await inquirer.prompt([
      {
        name: 'depositType',
        type: 'list',
        message: 'Deposit type:',
        choices: [
          { name: 'Posted Content / Preprint', value: 'preprint' },
          { name: 'Journal', value: 'journal' },
          { name: 'Conference Proceeding', value: 'conference' },
        ],
      },
    ]);
    depositType = resp.depositType;
  }
  if (!depositType) {
    throw new Error('No deposit type specified');
  }
  if (!name) {
    const resp = await inquirer.prompt([
      {
        name: 'name',
        type: 'string',
        message: 'Depositor name:',
      },
    ]);
    name = resp.name;
  }
  if (!email) {
    const resp = await inquirer.prompt([
      {
        name: 'email',
        type: 'string',
        message: 'Depositor email:',
      },
    ]);
    email = resp.email;
  }
  if (!name || !email) throw new Error('Depositor name/email not provided');
  if (!registrant) {
    const resp = await inquirer.prompt([
      {
        name: 'registrant',
        type: 'string',
        message: 'Registrant:',
      },
    ]);
    registrant = resp.registrant;
  }
  if (!prefix) prefix = 'curvenote';
  const depositSources = await getDepositSources(session, opts);
  const depositArticles = (
    await Promise.all(depositSources.map((source) => depositArticleFromSource(session, source)))
  ).sort(
    (a, b) => Number(a.frontmatter.biblio?.first_page) - Number(b.frontmatter.biblio?.first_page),
  );
  if (depositArticles.length === 0) {
    throw Error('nothing found for deposit');
  }
  console.log(`🔍 Found ${plural('%s article(s)', depositArticles)} for ${depositType} deposit`);
  const {
    journalTitle,
    journalAbbr,
    journalDoi,
    volume,
    issue,
    issueDoi,
    publicationDate,
    journalSeries,
    journalIssn,
    eventNumber,
    eventDate,
    eventLocation,
    proceedingsTitle,
    proceedingsPublisher,
    proceedingsSubject,
    proceedingsEditors,
  } = issueDataFromArticles(session, depositArticles, opts);
  const count = depositArticles.filter(({ frontmatter }) => !frontmatter.doi).length;
  const newDois = await selectNewDois(count, prefix);
  depositArticles.forEach(({ frontmatter, configFile }) => {
    if (frontmatter.doi) return;
    const doi = newDois.shift();
    frontmatter.doi = doi;
    if (configFile && doi) {
      addDoiToConfig(configFile, doi);
    }
  });

  let body: Element;
  if (depositType === 'journal') {
    if (!journalTitle || !journalDoi) throw new Error('Journal title and DOI are required');
    let journalIssue: JournalIssue | undefined;
    console.log('Deposit summary:');
    console.log('  Journal:');
    console.log(`    Title: ${journalTitle}${journalAbbr ? ` (${journalAbbr})` : ''}`);
    if (journalDoi) console.log(`    Doi: ${journalDoi}`);
    if (volume || issue || issueDoi) {
      if (!publicationDate) {
        throw new Error(`publication date is required for journal issue`);
      }
      console.log('  Issue:');
      console.log(`    Publication Date: ${publicationDate.toDateString()}`);
      if (volume) console.log(`    Volume: ${volume}`);
      if (issue) console.log(`    Issue: ${issue}`);
      if (issueDoi) console.log(`    Doi: ${issueDoi}`);
      journalIssue = {
        publication_dates: [publicationDate],
        volume,
        issue,
        doi_data: issueDoi ? curvenoteDoiData(issueDoi) : undefined,
      };
    }
    console.log('  Articles:');
    depositArticles.forEach(({ frontmatter }) => {
      console.log(
        `    ${frontmatter.doi} - ${frontmatter.title?.slice(0, 30)}${(frontmatter.title?.length ?? 0) > 30 ? '...' : ''}`,
      );
    });
    body = journalXml(
      {
        title: journalTitle,
        abbrevTitle: journalAbbr,
        doi_data: curvenoteDoiData(journalDoi),
      },
      journalIssue,
      depositArticles.map(({ frontmatter, dois, abstract }) => {
        return journalArticleFromMyst(session, frontmatter, dois, abstract);
      }),
    );
  } else if (depositType === 'conference') {
    if (!journalTitle) {
      throw new Error(`venue title is required for conference`);
    }
    console.log('Deposit summary:');
    console.log('  Conference:');
    console.log(`    Title: ${journalTitle}${journalAbbr ? ` (${journalAbbr})` : ''}`);
    const event = {
      name: journalTitle,
      acronym: journalAbbr,
      number: eventNumber,
      date: eventDate,
      location: eventLocation,
    };
    let series: ConferenceOptions['series'] | undefined;
    if (journalSeries && journalIssn) {
      console.log('  Series:');
      console.log(`    Title: ${journalSeries}`);
      console.log(`    ISSN: ${journalIssn}`);
      if (journalDoi) console.log(`    Doi: ${journalDoi}`);
      series = {
        title: journalSeries,
        original_language_title: journalSeries,
        issn: journalIssn,
        doi_data: journalDoi ? curvenoteDoiData(journalDoi) : undefined,
      };
    }
    if (!proceedingsTitle) {
      throw new Error(`title is required for proceedings`);
    }
    if (!publicationDate) {
      throw new Error(`publication date is required for proceedings`);
    }
    if (!proceedingsPublisher) {
      throw new Error(`publisher is required for proceedings`);
    }
    console.log('  Proceedings:');
    console.log(`    Title: ${proceedingsTitle}`);
    console.log(`    Publication Date: ${publicationDate.toDateString()}`);
    if (issueDoi) console.log(`    Doi: ${issueDoi}`);
    const proceedings = {
      title: proceedingsTitle,
      publisher: { name: proceedingsPublisher },
      publication_date: publicationDate,
      subject: proceedingsSubject,
      doi_data: issueDoi ? curvenoteDoiData(issueDoi) : undefined,
    };
    console.log('  Papers:');
    depositArticles.forEach(({ frontmatter }) => {
      console.log(
        `    ${frontmatter.doi} - ${frontmatter.title?.slice(0, 30)}${(frontmatter.title?.length ?? 0) > 30 ? '...' : ''}`,
      );
    });
    body = conferenceXml({
      contributors: proceedingsEditors,
      event,
      series,
      proceedings,
      conference_papers: depositArticles.map(({ frontmatter, dois, abstract }) => {
        return conferencePaperFromMyst(frontmatter, dois, abstract);
      }),
    });
  } else {
    if (depositArticles.length > 1) {
      throw new Error('preprint deposit may only use a single article');
    }
    const { frontmatter, dois, abstract } = depositArticles[0];
    body = preprintFromMyst(frontmatter, dois, abstract);
  }
  const batch = new DoiBatch(
    { id: opts.id ?? uuid(), depositor: { name, email }, registrant },
    body,
  );
  if (opts.output) {
    fs.writeFileSync(opts.output, batch.toXml());
  } else {
    console.log(batch.toXml());
  }
}

function makeDepositCLI(program: Command) {
  const command = new Command('deposit')
    .description('Create Crossref deposit XML from local MyST content')
    .addOption(new Option('--file <value>', 'File to deposit'))
    .addOption(
      new Option('--type <value>', 'Deposit type')
        .choices(['conference', 'journal', 'preprint'])
        .default('preprint'),
    )
    .addOption(new Option('--id <value>', 'Deposit batch id'))
    .addOption(new Option('--name <value>', 'Depositor name').default('Curvenote'))
    .addOption(new Option('--email <value>', 'Depositor email').default('doi@curvenote.com'))
    .addOption(new Option('--registrant <value>', 'Registrant organization').default('Crossref'))
    .addOption(new Option('-o, --output <value>', 'Output file'))
    .addOption(new Option('--prefix <value>', 'Prefix for new DOIs'))
    .action(clirun(deposit, { program, getSession: (logger) => new Session({ logger }) }));
  return command;
}

export function addDepositCLI(program: Command) {
  program.addCommand(makeDepositCLI(program));
}
