import childProcess from 'child_process';
import fs from 'fs';
import GithubApi from 'github';
import R from 'ramda';
import { ISSUE_TYPES } from '../util';
import { debug, debugCurried, debugCurriedP, promisify, wrapInPromise } from '../../util';
import { errors, catchPromiseAndThrow, throwControlledError } from '../../error';
import reporter from '../../reporter';

const github = new GithubApi({});

const getCurrentUser = R.compose(
  R.partial(R.__, [{}]),
  promisify
)(github.users.get);

const createPullRequest = promisify(github.pullRequests.create);

const authenticate = R.compose(
  wrapInPromise,
  (token) => github.authenticate(token),
  R.set(R.lensProp('token'), R.__, { type: 'token' })
);

const readUserToken = R.compose(
  R.partial(reporter.question, [{ question: 'Introduce a Github personal token' }]),
  debugCurried('github', 'Github account not set')
);

const authenticateAndGetCurrentUser = R.composeP(
  R.compose(catchPromiseAndThrow('github', e => {
    switch (e.code) {
      case '500':
        return errors.github.cantConnect;
      default:
        return errors.github.tokenInvalid;
    }
  }), getCurrentUser),
  authenticate
);


// Object -> String -> String
const buildPullRequestTitle = R.ifElse(
  R.isNil,
  R.compose(R.concat(R.__, '\n'), R.nthArg(1)),
  issue => `${ISSUE_TYPES[issue.fields.issuetype.name]}/${issue.key} ${R.take(60, issue.fields.summary)}\n`
);

// Array -> String
const buildPullRequestBody = R.compose(
  R.join('\n'),
  R.map(
    R.compose(
      R.join('\n'),
      R.converge(R.prepend, [
        R.compose(R.concat('* '), R.head),
        R.compose(R.map(R.concat('  ')), R.tail)
      ]),
      R.split('\n'),
      R.prop('message')
    )
  )
);
// Object -> Array -> String
const buildPullRequestFooter = issueRoot => R.compose(
  R.concat('\nFixes '),
  R.join(', '),
  R.map((issue) => `[${issue}](${issueRoot}${R.tail(issue)})`),
  R.uniq,
  R.flatten,
  R.map(R.ifElse(R.has('key'), R.compose(R.concat('#'), R.prop('key')), R.prop('issues'))),
  R.reject(R.either(R.isEmpty, R.isNil)),
  R.prepend
);

// Object -> Array -> String
const buildPullRequestDescription = issueRoot => R.converge(
  R.compose(wrapInPromise, R.unapply(R.join('\n'))),
  [
    buildPullRequestTitle,
    R.compose(buildPullRequestBody, R.nthArg(2)),
    R.compose(
      R.apply(buildPullRequestFooter(issueRoot)),
      R.unapply(R.remove(1, 1)),
    )
  ]
);

// String -> String -> *
const writeFile = R.curryN(2, (file, content) => promisify(fs.writeFile)(file, content, 'utf8'));
// String -> * -> String
const readFile = file => () => promisify(fs.readFile)(file, 'utf8');
// String -> String -> String
const deleteFile = file => content => promisify(fs.unlink)(file).then(() => wrapInPromise(content));
// * -> String
const editFile = file => () => new Promise((resolve, reject) => {
  const vim = childProcess.spawn('vim', [file], { stdio: 'inherit' });
  vim.on('exit', R.ifElse(R.equals(0), resolve, reject));
});

// Object -> String -> String
const allowUserToEditPullRequest = (description) => {
  const prFile = `/tmp/fotingo-pr-${Date.now()}`;
  return R.composeP(
    R.compose(wrapInPromise, R.trim),
    deleteFile(prFile),
    readFile(prFile),
    editFile(prFile),
    writeFile(prFile)
  )(description);
};

const submitPullRequest = R.curryN(4, (config, project, branchInfo, description) => createPullRequest({
  owner: config.get(['github', 'owner']),
  repo: project,
  head: branchInfo.name,
  base: config.get(['github', 'base']),
  title: R.compose(R.head, R.split('\n'))(description),
  body: R.compose(R.join('\n'), R.tail, R.split('\n'))(description)
}));

export default {
  init: config => () => {
    debug('github', 'Initializing Github api');

    const doLogin = R.composeP(
      authenticateAndGetCurrentUser,
      config.update(['github', 'token']),
      readUserToken
    );

    const configPromise = R.isNil(config.get(['github', 'owner']))
      ? R.composeP(
        config.update(['github', 'owner']),
        reporter.question
      )({ question: 'What\'s the github repository owner?' })
      : wrapInPromise(config.get(['github', 'owner']));

    return configPromise.then(() => {
      if (config.isGithubLoggedIn()) {
        debug('github', 'User token is present. Using current authentication');
        return authenticateAndGetCurrentUser(config.get(['github', 'token']))
          // TODO differentiate error codes so only login is attempted when tokenInvalid
          .catch(R.composeP(doLogin, debugCurriedP('github', 'Current authentication failed. Attempting login')));
      }
      debug('github', 'No user token present. Attempting login');
      return doLogin();
    });

  },
  // Object -> Array -> Promise
  createPullRequest: R.curryN(5, (config, project, issue, issueRoot, branchInfo) =>
    R.composeP(
      R.ifElse(R.isEmpty,
        throwControlledError(errors.github.pullRequestDescriptionInvalid),
        // Assign the PR link to all the issues that were created
        R.composeP(
          R.converge(
            (issues, pullRequest) => ({ issues, pullRequest }),
            [
              R.compose(
                R.ifElse(R.partial(R.isNil, [issue]), R.identity, R.append(issue)),
                R.map(R.compose(R.set(R.lensProp('key'), R.__, {}), R.tail)),
                R.flatten,
                R.map(R.prop('issues')), R.view(R.lensPath(['branchInfo', 'commits']))
              ),
              R.prop('pullRequest')
            ]
          ),
          R.compose(wrapInPromise, R.set(R.lensProp('pullRequest'), R.__, { branchInfo })),
          submitPullRequest(config, project, branchInfo)
        )
      ),
      debugCurriedP('github', 'Submitting pull request to github'),
      allowUserToEditPullRequest,
      debugCurriedP('github', 'Editing pull request description'),
      buildPullRequestDescription(issueRoot),
    )(issue, branchInfo.name, branchInfo.commits))
};