const axios = require('axios')
const moment = require('moment')
const util = require('util')
const aws = require('aws-sdk')
const orgId = process.env.org_id
let userMap = new Map()
let taskMap = new Map()
let projectMap = new Map()
let standupHeader = '_*Daily Stand up | ' + moment().format('ll') + '*_\n'
const TABBER = '    '
const flowUrl = 'https://app.getflow.com/organizations/' + orgId
const slackUrl =
  'https://hooks.slack.com/services/' +
  // TEST
  process.env.slack_test
  // PROD
  // process.env.slack_proto
const ssm = new aws.SSM({
  apiVersion: '2014-11-06',
  region: 'us-east-1'
})
let axiosInstance = axios.create({
  baseURL: 'https://api.getflow.com/v2/',
  headers: {
    'Content-Type': 'application/vnd.flow.v2+json',
    Accept: 'application/vnd.flow.v2+json'
  },
  timeout: 300000
})

axiosInstance.interceptors.request.use(request => {
  console.log('Starting request to URL: "', request.url, '"')
  return request
})

// exports.handler = event => {
  generateStandup();
// }

function generateStandup(event) {
  axios
    .post(
      slackUrl, {
        text: standupHeader
      }, {
        headers: {
          'Content-type': 'application/json'
        }
      }
    )
    .then(res => {
      const response = {
        statusCode: 200,
        body: util.inspect(res.data)
      }
      return response
    })
    .catch(err => {
      console.error(err)
      const response = {
        statusCode: 500,
        body: util.inspect(err)
      }
      return response
    })
  ssm.getParameter({
      Name: 'flow_tokens',
      WithDecryption: true
    },
    async (err, data) => {
      if (err) console.log(err, err.stack)
      // an error occurred
      else {
        // successful response
        let tokens = JSON.parse(data.Parameter.Value)
        let response = await fetchTeamsAndAccounts(
          'workspaces?include=accounts&organization_id=' + orgId,
          tokens[Object.keys(tokens)[0]]
        )
        response.accounts.forEach(account => {
          userMap.set(
            account.id,
            Object.keys(tokens).find(x => {
              return account.name
                .toLowerCase()
                .includes(x.split(' ')[0].toLowerCase())
            })
          )
        })

        ssm.getParameter({
            Name: 'slack_ids',
            WithDecryption: true
          },
          async (err, data) => {
            if (err) console.log(err, err.stack)
            // an error occurred
            else {
              // successful response
              let members = JSON.parse(data.Parameter.Value)

              Object.keys(tokens).forEach(userName => {
                let token = tokens[userName]
                let account = response.accounts.find(x => {
                  return x.name
                    .toLowerCase()
                    .includes(userName.split(' ')[0].toLowerCase())
                })

                let id = members[userName]

                let yesterdayStart, yesterdayEnd;
                if (moment().isoWeekday() == 1) {
                  yesterdayStart = moment()
                    .startOf('day')
                    .subtract(3, 'days')
                    .minutes(30)
                    .hours(3)
                    .format('YYYY-MM-DD[T]HH:mm:ss.SSS[Z]')
                  yesterdayEnd = moment()
                    .endOf('day')
                    .minutes(30)
                    .hours(3)
                    .format('YYYY-MM-DD[T]HH:mm:ss.SSS[Z]')
                } else {
                  yesterdayStart = moment()
                    .startOf('day')
                    .minutes(30)
                    .hours(3)
                    .subtract(1, 'days')
                    .format('YYYY-MM-DD[T]HH:mm:ss.SSS[Z]')
                  yesterdayEnd = moment()
                    .endOf('day')
                    .minutes(30)
                    .hours(3)
                    .format('YYYY-MM-DD[T]HH:mm:ss.SSS[Z]')
                }
                activityResponse = fetchActivities(
                  'activities?order=created_at&include=tasks' +
                  '&task_owner_id=' +
                  account.id +
                  '&before=' +
                  yesterdayEnd +
                  '&after=' +
                  yesterdayStart +
                  '&only_action=add_comment,complete' +
                  '&organization_id=' +
                  orgId,
                  token
                )
                activityResponse.then(response => {
                  let projectSet = new Set()
                  response.tasks.forEach(task => {
                    taskMap.set(task.id, task)
                    if (task.list_id && !projectMap.has(task.list_id)) {
                      projectSet.add(
                        'lists/' +
                        task.list_id +
                        '?organization_id=' +
                        orgId +
                        '&workspace_id=' +
                        task.workspace_id
                      )
                    }
                  })
                  projectSet = [...projectSet].map(x => {
                    return axiosInstance.get(x, {
                      headers: {
                        Authorization: 'Bearer ' + token
                      }
                    })
                  })
                  axios.all([...projectSet]).then(projectResponse => {
                    projectResponse.forEach(res => {
                      projectMap.set(res.data.list.id, res.data.list.name)
                    })
                    retrieveEODData(
                      response.activities || [],
                      account.id,
                      token, 
                      id
                    ).then(userStandup => {
                      let tasksResponse = fetchTasks(
                        'tasks?completed=false&deleted=false&view=owned&include=parent,children&organization_id=' +
                        orgId,
                        token
                      )
                      tasksResponse.then(tasks => {
                        if (tasks.outcomes.length === 0) {
                          userStandup +=
                            '*:x: This week\'s data could not be retrieved.*\n'
                          axios
                            .post(
                              slackUrl, {
                                text: userStandup
                              }, {
                                headers: {
                                  'Content-type': 'application/json'
                                }
                              }
                            )
                            .then(res => {
                              const response = {
                                statusCode: 200,
                                body: util.inspect(res.data)
                              }
                              return response
                            })
                            .catch(err => {
                              console.error(err)
                              const response = {
                                statusCode: 500,
                                body: util.inspect(err)
                              }
                              return response
                            })
                        } else {
                          let outcomeRequests = []
                          tasks.outcomes.forEach(outcome =>
                            outcomeRequests.push(
                              axiosInstance.get(
                                'tasks/' + outcome + '?organization_id=' + orgId, {
                                  headers: {
                                    Authorization: 'Bearer ' + token
                                  }
                                }
                              )
                            )
                          )
                          axios.all(outcomeRequests).then(response => {
                            tasks.outcomes = []
                            let projectMap = new Map()
                            response.forEach(outcome => {
                              tasks.outcomes.unshift(parseTask(outcome.data.task))
                              projectMap.set(
                                outcome.data.task.list_id,
                                outcome.data.task.workspace_id
                              )
                            })
                            let projectRequests = []
                            projectMap.forEach((v, k, m) =>
                              projectRequests.push(
                                axiosInstance.get(
                                  'lists/' +
                                  k +
                                  '?workspace_id=' +
                                  v +
                                  '&organization_id=' +
                                  orgId, {
                                    headers: {
                                      Authorization: 'Bearer ' + token
                                    }
                                  }
                                )
                              )
                            )

                            axios.all(projectRequests).then(projectResponse => {
                              let projectMap = new Map()
                              projectResponse.forEach(response => {
                                let outcomes = tasks.outcomes
                                  .filter(x => x.project_id === response.data.list.id)
                                  .sort((x, y) => x.due_on > y.due_on)
                                projectMap.set(response.data.list.id, {
                                  name: response.data.list.name,
                                  team_id: response.data.list.workspace_id,
                                  outcomes: outcomes
                                })
                              })
                              let week = moment().format('w');
                              userStandup += '\n*My outcomes/deliverables for week ' + week + ' are:*\n'

                              let outcomeMap = new Map()


                              projectMap.forEach((v, k, m) => {
                                let project_url =
                                  flowUrl + '/teams/' + v.team_id + '/lists/' + k
                                userStandup += '> *Project: <' + project_url + '|[' + v.name + ']>*\n'

                                v.outcomes.forEach(x => {
                                  let outcome = x
                                  userStandup +=
                                    '> ' +
                                    TABBER +
                                    isOverdue(outcome.due_on) +
                                    ' ' +
                                    outcome.name +
                                    ' ' +
                                    formatComments(outcome.comments_count) +
                                    ' ' +
                                    formatDate(outcome.starts_on) +
                                    '-' +
                                    formatDate(outcome.due_on) +
                                    '\n'

                                  let subtasks = tasks.subtasks
                                    .filter(x => x.outcome_id === outcome.id)
                                    .sort((x, y) => x.due_on > y.due_on)
                                  outcomeMap.set(outcome.id, {
                                    name: outcome.name,
                                    team_id: outcome.team_id,
                                    subtasks: subtasks
                                  })
                                })
                              })

                              userStandup += '\n\n'
                              userStandup +=
                                '*To achieve those week ' + week + ' outcomes/deliverables, I am allocating time to following subtasks/activities:*\n'

                              outcomeMap.forEach((v, k, m) => {
                                let outcome_url =
                                  flowUrl + '/teams/' + v.team_id + '/tasks/' + k

                                if (v.subtasks.length > 0) {
                                  // if (v.subtasks.some(x => x.flagged)) {
                                  userStandup +=
                                    '> *Outcome: <<' + outcome_url + '|_' + v.name + '_>>*\n'
                                  v.subtasks.forEach(x => {
                                    userStandup +=
                                      '> ' +
                                      TABBER +
                                      isOverdue(x.due_on) +
                                      ' ' +
                                      x.name +
                                      ' ' +
                                      formatComments(x.comments_count) +
                                      ' ' +
                                      formatDate(x.starts_on) +
                                      '-' +
                                      formatDate(x.due_on) +
                                      '\n'
                                  })
                                  // }
                                } else {
                                  userStandup +=
                                    '> *Outcome: <<' + outcome_url + '|_' + v.name + '_>>*\n> ' + TABBER + TABBER + '... \n'
                                }
                              })

                              axios
                                .post(
                                  slackUrl, {
                                    text: userStandup
                                  }, {
                                    headers: {
                                      'Content-type': 'application/json'
                                    }
                                  }
                                )
                                .then(res => {
                                  const response = {
                                    statusCode: 200,
                                    body: util.inspect(res.data)
                                  }
                                  return response
                                })
                                .catch(err => {
                                  console.error(err)
                                  const response = {
                                    statusCode: 500,
                                    body: util.inspect(err)
                                  }
                                  return response
                                })
                            })
                          })
                        }
                      })
                    })
                  })
                })
              })
            }
          })
      }
    })
}

async function retrieveEODData(currentActivities, user_id, token, id) {
  let taskActivityMap = new Map()
  currentActivities.forEach(x => {
    if (taskActivityMap.has(x.target_id)) {
      taskActivityMap.get(x.target_id).unshift(x)
    } else {
      taskActivityMap.set(x.target_id, [x])
    }
  })
  let outcomeTaskMap = new Map()
  for ([x, v] of taskActivityMap) {
    let task = taskMap.get(x)
    v = v.filter(x => x.action === 'add_comment')
    if (!task.parent_id) {
      if (outcomeTaskMap.has(task.id)) {
        let outcome = outcomeTaskMap.get(task.id)
        outcome = {
          id: task.id,
          name: task.name,
          project_id: task.list_id,
          completed: task.completed,
          activities: v,
          tasks: outcome.tasks
        }
        outcomeTaskMap.set(task.id, outcome)
      } else {
        outcomeTaskMap.set(task.id, {
          id: task.id,
          name: task.name,
          project_id: task.list_id,
          completed: task.completed,
          activities: v,
          tasks: null
        })
      }
    } else {
      if (!taskMap.has(task.parent_id)) {
        let taskResponse = await axiosInstance.get(
          'tasks/' + task.parent_id + '?organization_id=' + orgId, {
            headers: {
              Authorization: 'Bearer ' + token
            }
          }
        )
        taskMap.set(task.parent_id, taskResponse.data.task)
      }
      if (outcomeTaskMap.has(task.parent_id)) {
        if (outcomeTaskMap.get(task.parent_id).tasks) {
          outcomeTaskMap.get(task.parent_id).tasks.push({
            name: task.name,
            activities: v,
            completed: task.completed
          })
        } else {
          outcomeTaskMap.get(task.parent_id).tasks = [{
            name: task.name,
            activities: v,
            completed: task.completed
          }]
        }
      } else {
        let parentTask = taskMap.get(task.parent_id)
        outcomeTaskMap.set(task.parent_id, {
          id: task.parent_id,
          name: parentTask.name,
          project_id: parentTask.list_id,
          completed: parentTask.completed,
          activities: null,
          tasks: [{
            name: task.name,
            activities: taskActivityMap.get(task.id),
            completed: task.completed
          }]
        })
      }
    }
  }

  let projectOutcomeMap = new Map()
  outcomeTaskMap.forEach((v, k, m) => {
    if (projectOutcomeMap.has(v.project_id)) {
      projectOutcomeMap.get(v.project_id).outcomes.push(v)
    } else {
      projectOutcomeMap.set(v.project_id, {
        name: projectMap.get(v.project_id),
        outcomes: [v]
      })
    }
  })

  return formatText(projectOutcomeMap, user_id, id);
}

function formatText(projectOutcomeMap, user_id, id) {
  let userStandup = ''
  userStandup += '\n `<@' + id + '>`' + '\n'
  userStandup += projectOutcomeMap.size > 0 ? '\n*What did I do yesterday?*' + '\n' : '\n*:x: Yesterday\'s data could not be retrieved.*' + '\n'
  projectOutcomeMap.forEach((v, k, m) => {
    v.outcomes = v.outcomes.filter(outcome => {
      return (
        outcome.completed ||
        (outcome.activities && outcome.activities.length > 0) ||
        (outcome.tasks &&
          outcome.tasks.some(
            x => x.completed || (x.activities && x.activities.length > 0)
          ))
      )
    })
    if (v.outcomes.length > 0) {
      let project_url = flowUrl + '/teams/' + v.team_id + '/lists/' + k
      userStandup += '> *Project: <' + project_url + '|[' + v.name + ']>*\n'
    }
    v.outcomes.forEach(x => {
      let name = x.completed ?
        ':black_small_square: ~_*' + x.name + '*_~' :
        ':white_small_square: _*' + x.name + '*_'

      x.activities =
        x.activities && x.activities.filter(x => x.action === 'add_comment')
      if (
        (x.tasks && x.tasks.length > 0) ||
        (x.activities && x.activities.length > 0) ||
        x.completed
      ) {
        userStandup += '> ' + TABBER + name + '\n'
      }

      if (x.activities) {
        if (x.activities.length > 0) {
          userStandup += '> ' + TABBER + TABBER + TABBER + ' :speech_balloon: \n'
          x.activities.forEach(activity => {
            userStandup +=
              '> ' +
              TABBER +
              TABBER +
              TABBER +
              '  -   ' +
              // translateAction(activity.action) +
              parseActivityPayload(activity) +
              '\n'
          })
        }
      }
      if (x.tasks && x.tasks.length > 0) {
        x.tasks.forEach(task => {
          let name = task.completed ?
            '■ ~_*' + task.name + '*_~' :
            '□ _*' + task.name + '*_'

          if (task.activities) {
            task.activities = task.activities.filter(
              x => x.action === 'add_comment'
            )
            if (task.activities.length > 0 || task.completed) {
              userStandup += '> ' + TABBER + TABBER + TABBER + name + '\n'
            }
            if (task.activities.length > 0) {
              task.activities.forEach(activity => {
                userStandup +=
                  '> ' +
                  TABBER +
                  TABBER +
                  TABBER +
                  TABBER +
                  '  -   ' +
                  // translateAction(activity.action) +
                  parseActivityPayload(activity) +
                  '\n'
              })
            }
          }
        })
      }
    })
  })
  return userStandup
}

function getNextURI(current_uri) {
  let nextLink = current_uri.split(',').find(x => {
    return x.match(/<.*>; rel="next"/g)
  })
  if (nextLink) {
    nextLink = nextLink.substring(
      nextLink.indexOf('<') + 28,
      nextLink.indexOf('>')
    )
  }
  return nextLink
}
async function fetchTeamsAndAccounts(uri_string, token) {
  try {
    let res = await axiosInstance.get(uri_string, {
      headers: {
        Authorization: 'Bearer ' + token
      }
    })
    let nextLink = getNextURI(res.headers.link)
    let workspaces = res.data.workspaces
    workspaces = workspaces.map(x => {
      return {
        id: x.id,
        name: x.name
      }
    })
    let accounts = res.data.accounts
    accounts = accounts.map(x => {
      return {
        id: x.id,
        name: x.name,
        email: x.email,
        joined: x.joined,
        demo: x.demo
      }
    })
    if (nextLink) {
      let nextCall = await fetchTeamsAndAccounts(nextLink, token)
      return {
        workspaces: workspaces.concat(nextCall.workspaces),
        accounts: accounts.concat(nextCall.accounts)
      }
    } else {
      return {
        workspaces: workspaces,
        accounts: accounts
      }
    }
  } catch (err) {
    console.error(
      'Unable to retrieve list of workspaces and/or accounts either.'
    )
    console.error(err)
    return {
      workspaces: [],
      accounts: []
    }
  }
}

async function fetchActivities(uri_string, token) {
  try {
    let res = await axiosInstance.get(uri_string, {
      headers: {
        Authorization: 'Bearer ' + token
      }
    })
    console.log(res)
    let nextLink = getNextURI(res.headers.link)
    let activities = res.data.activities || []
    let tasks = res.data.tasks || []
    let lists = res.data.lists || []
    if (nextLink) {
      let nextCall = await fetchActivities(nextLink, token)
      let nextActivites = nextCall.activities ? nextCall.activities : []
      let nextTasks = nextCall.tasks ? nextCall.tasks : []
      let nextLists = nextCall.lists ? nextCall.lists : []
      return {
        activities: activities.concat(nextActivites),
        tasks: tasks.concat(nextTasks),
        lists: lists ? lists.concat(nextLists) : nextLists
      }
    } else {
      return {
        activities: activities,
        tasks: tasks,
        lists: lists
      }
    }
  } catch (err) {
    console.error('Unable to retrieve list of available activities.')
    console.error(err)
    return {
      activities: [],
      tasks: [],
      lists: []
    }
  }
}

function parseActivityPayload(activity) {
  let action = activity.action
  let payload = activity.payload
  switch (action) {
    case 'create':
      return ''
    case 'delete':
      return ''
    case 'add_comment':
      let comment = cleanComment(payload.comment.content)
      return '_*' + userMap.get(activity.account_id) + ':* ' + comment + ' _'
    case 'complete':
      return ''
    case 'set_owner':
      return userMap.get(payload.owner_id)
    case 'change_timeline':
      return (
        '[' +
        payload.starts_on_was +
        ' - ' +
        payload.due_on_was +
        '] => [' +
        payload.starts_on +
        ' - ' +
        payload.due_on +
        ']'
      )
    case 'set_starts_on':
      return payload.starts_on
    case 'set_due':
      return payload.due_on
    case 'set_list':
      return payload.list_name
    case 'set_section':
      return payload.section_name
    case 'change_section':
      return payload.section_name_was + ' => ' + payload.section_name
    default:
      return 'Unknown action'
  }
}

function cleanComment(comment) {
  return comment.replace(/\[(.*?)\]\(.*?\)/g, '$1')
}

async function fetchTasks(uri_string, token, tasks) {
  return axiosInstance
    .get(uri_string, {
      headers: {
        Authorization: 'Bearer ' + token
      }
    })
    .then(res => {
      if (!tasks) {
        tasks = {
          outcomes: [],
          subtasks: []
        }
      }
      let nextLink = getNextURI(res.headers.link)
      let subtasks = res.data.tasks ? res.data.tasks : []
      subtasks = subtasks.filter(x => isSubtask(x) && isWithinReportRange(x))
      let outcomes = []
      subtasks = subtasks.map(x => {
        let outcome = res.data.parents.find(parent => parent.id === x.parent_id)
        outcomes.push({
          id: outcome.id,
          project_id: x.list_id,
          team_id: x.workspace_id,
          name: outcome.name
        })
        return parseTask(x)
      })
      let temp = res.data.tasks.filter(
        x => !isSubtask(x) && isWithinReportRange(x)
      )

      outcomes = outcomes.concat(temp).map(x => x.id)

      tasks = {
        outcomes: tasks.outcomes.concat(outcomes),
        subtasks: tasks.subtasks.concat(subtasks)
      }
      if (nextLink) {
        return fetchTasks(nextLink, token, tasks)
      } else {
        return {
          outcomes: [...new Set(tasks.outcomes)],
          subtasks: tasks.subtasks
        }
      }
    })
}

function isWithinReportRange(x) {
  return (
    x.due_on >
    moment()
    .startOf('week')
    .format('YYYY-MM-DD') &&
    x.due_on <
    moment()
    .endOf('week')
    .format('YYYY-MM-DD')
  )
}

function isSubtask(x) {
  return !!x.parent_id
}

function isOverdue(due_on) {
  return due_on <
    moment()
    .startOf('day')
    .format('YYYY-MM-DD') ?
    ':warning:' :
    '  -  '
}

function formatDate(x) {
  return x ? moment(x).format('DDMMM') : '*NA*'
}

function formatComments(x) {
  return '■ (' + x.toString().padStart(2, '0') + ' comments)'
}

function parseTask(task) {
  return {
    id: task.id,
    project_id: task.list_id,
    team_id: task.workspace_id,
    name: task.name,
    starts_on: task.starts_on,
    due_on: task.due_on,
    comments_count: task.comments_count,
    outcome_id: task.parent_id,
    flagged: task.flagger_ids.includes(task.owner_id)
  }
}