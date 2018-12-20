// const fs = require('fs');
// const path = require('path');
const axios = require('axios');
const origin = require('git-remote-origin-url');
const matter = require('gray-matter');
const html = require('remark-html');
const remark = require('remark');
const slug = require('remark-slug');
const {JSDOM} = require('jsdom');

// exports.onCreateWebpackConfig = ({actions, loaders}) =>
//   actions.setWebpackConfig({
//     module: {
//       rules: [
//         {
//           test: /\.js$/,
//           include: path.dirname(require.resolve('gatsby-theme-apollo')),
//           use: [loaders.js()]
//         }
//       ]
//     }
//   });

// copy the theme favicon to the built site
// exports.onPostBootstrap = ({store}) => {
//   const {program} = store.getState();
//   const source = `${__dirname}/static/favicon.ico`;
//   const destination = `${program.directory}/public/favicon.ico`;
//   fs.copyFileSync(source, destination);
// };

const sourceDir = 'docs/source';
const api = axios.create({
  headers: {
    Accept: 'application/vnd.github.v3+json',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
  }
});

async function fetchDirectory(url, basePath, options) {
  const response = await api.get(url, options);
  return await Promise.all(
    response.data
      .filter(
        content =>
          content.type === 'dir' ||
          (content.type === 'file' && /\.mdx?$/.test(content.name))
      )
      .map(content =>
        content.type === 'file'
          ? fetchFile(content.url, basePath, options)
          : fetchDirectory(content.url, basePath, options)
      )
  );
}

async function fetchFile(url, basePath, options) {
  const {data} = await api.get(url, options);
  const buffer = Buffer.from(data.content, data.encoding);
  const {data: frontmatter, content} = matter(buffer.toString('utf8'));
  const processed = remark()
    .use(html, {
      sanitize: {
        allowComments: false
      }
    })
    .use(slug)
    .processSync(content);
  return {
    ...data,
    frontmatter,
    html: processed.contents,
    path:
      basePath +
      data.path
        .slice(0, data.path.lastIndexOf('.'))
        .replace(sourceDir, '')
        .replace('/index', '')
  };
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/flat#reduce_and_concat
function flattenDeep(array) {
  return array.reduce(
    (acc, value) =>
      Array.isArray(value) ? acc.concat(flattenDeep(value)) : acc.concat(value),
    []
  );
}

const versionSegment = '(\\d+)(\\.\\d+){2}';
const versionPattern = new RegExp(versionSegment);

exports.createPages = async ({graphql, actions}) => {
  const docsTemplate = require.resolve('./src/templates/docs');

  const tags = [];
  const url = await origin();
  const match = url.match(/\/([\w-]+)\/([\w-]+)\.git$/);
  const owner = match[1];
  const repo = 'apollo-server'; // or match[2];
  const patterns = [
    new RegExp(`^v${versionSegment}$`),
    new RegExp(`^${repo}@${versionSegment}$`)
  ];

  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const result = await graphql(`
      {
        github {
          repository(owner: "${owner}", name: "${repo}") {
            name
            refs(
              after: ${cursor}
              first: 100
              refPrefix: "refs/tags/"
              orderBy: {field: TAG_COMMIT_DATE, direction: DESC}
            ) {
              pageInfo {
                endCursor
                hasNextPage
              }
              nodes {
                id
                name
              }
            }
          }
        }
      }
    `);

    const {pageInfo, nodes} = result.data.github.repository.refs;
    cursor = JSON.stringify(pageInfo.endCursor);
    hasNextPage = pageInfo.hasNextPage;
    tags.push(
      ...nodes.filter(node => patterns.some(pattern => pattern.test(node.name)))
    );
  }

  let versions = {};
  tags.forEach(tag => {
    const match = tag.name.match(versionPattern);
    const version = match[1];
    if (!versions[version]) {
      versions[version] = tag;
    }
  });

  versions = await Promise.all(
    Object.keys(versions).map(async key => {
      const {name} = versions[key];
      const basePath = `/v${key}`;
      try {
        const contents = await fetchDirectory(
          `https://api.github.com/repos/${owner}/${repo}/contents/${sourceDir}`,
          basePath,
          {
            params: {
              ref: name
            }
          }
        );

        return {
          id: key,
          tag: name,
          basePath,
          contents: flattenDeep(contents).filter(content =>
            Boolean(content.html.replace(/\n/g, ''))
          )
        };
      } catch (error) {
        console.error(error);
        return null;
      }
    })
  );

  versions.filter(Boolean).forEach((version, index, array) =>
    version.contents.forEach(({path, frontmatter, html}) => {
      const dom = new JSDOM(html);
      const headings = Array.from(
        dom.window.document.querySelectorAll('h1,h2,h3')
      ).map(heading => ({
        id: heading.id,
        text: heading.textContent
      }));

      actions.createPage({
        path,
        component: docsTemplate,
        context: {
          frontmatter,
          html,
          headings,
          version,
          versions: array
        }
      });
    })
  );
};
