import { run } from '../deps/cmd.ts'
import * as Render from '../deps/render.ts'
import * as Workflow from '../deps/workflow.ts'
import bump from '../deps/bump.ts'
import * as Update from '../deps/self_update.ts'
import * as git from '../deps/git.ts'
import * as Docker from '../deps/docker.ts'
import { Partial, merge, trimIndent } from '../deps/util.ts'

export interface Options {
	repo : string,
	docker?: Partial<DockerOptions>,
	scalaVersion?: string,
	strictPluginOverride?: string,
}

export interface DockerOptions {
	cmd: Array<string>,
	workdir: string,
	initRequires: Array<string>,
	initTargets: Array<string>,
	updateRequires: Array<string>,
	updateTargets: Array<string>,
	buildRequires: Array<string>,
	buildTargets: Array<string>,
	builderSetup: Array<Docker.Step>,
}

let jdkVersion = "11.0.13"

let defaultSbtVersion = "1.5.7"

let scalaVersion = "2.13.7"

export const defaultDockerOptions: DockerOptions = {
	cmd: [],
	workdir: "/app",
	initRequires: ["project"],
	initTargets: ["about"],
	updateRequires: ["build.sbt", "release.sbt"],
	updateTargets: ["update"],
	buildRequires: [],
	buildTargets: [],
	builderSetup: [],
}

function dockerChores(projectOpts: Options) {
	const opts = merge(defaultDockerOptions, projectOpts?.docker ?? {})

	const sbtImage = Docker.image(
			"hseeberger/scala-sbt",
			`${jdkVersion}_${defaultSbtVersion}_${projectOpts.scalaVersion ?? scalaVersion}`
		)

	function copyFiles(paths: string[]): Docker.Step[] {
		return paths.map(p => Docker.Step.copy(p, p))
	}

	function runSbt(deps: string[], targets: string[]): Docker.Step[] {
		if (targets.length ==- 0) {
			return []
		} else {
			return copyFiles(deps).concat([Docker.Step.run(['sbt'].concat(targets))])
		}
	}

	const builder = Docker.stage('builder', { from: sbtImage })
		.workdir(opts.workdir)
		.pushAll(opts.builderSetup)
		.pushAll(runSbt(opts.initRequires, opts.initTargets))
		.pushAll(runSbt(opts.updateRequires, opts.updateTargets))
		.pushAll(runSbt(opts.buildRequires, opts.buildTargets))

	const spec: Docker.Spec = {
		url: `ghcr.io/timbertson/${projectOpts.repo}`,
		stages: [ builder ]
	}

	return {
		async dockerLogin(opts: { user: string, token: string }) {
			await run([
				'docker', 'login', 'ghcr.io', '-u', opts.user, '--password-stdin'
			], { stdin: { contents: opts.token } })
		},

		async docker(_: {}) {
			await Docker.standardBuild(spec)
		},

		async dockerRun(opts: { args?: string[] }) {
			await Docker.run({
				image: Docker.imageForStage(spec, 'last'),
				cmd: opts.args,
				workDir: '/workspace',
				bindMounts: [
					{ path: Deno.cwd(), containerPath: '/workspace' },
				]
			})
		},

		dockerPrint(_: {}) {
			console.log(Docker.render(spec))
		}
	}
}

function files(opts: Options): Render.File[] {
	return [
		new Render.CFile('project/sonatype.sbt', trimIndent(`
			addSbtPlugin("com.jsuereth" % "sbt-pgp" % "2.0.1")
			addSbtPlugin("org.xerial.sbt" % "sbt-sonatype" % "3.9.7")
		`)),
		new Render.CFile('project/src/main/scala/PublishSettings.scala', trimIndent(`
			import sbt._
			import Keys._
			import xerial.sbt.Sonatype.SonatypeKeys._
			
			object ScalaProject {
				val hiddenProjectSettings = Seq(
					publish / skip := true,
				)
			
				def publicProjectSettings = Seq(
					publishTo := sonatypePublishToBundle.value,
					publishMavenStyle := true,
					Test / publishArtifact := false,
				)
			}
		`)),
		new Render.CFile('release.sbt', trimIndent(`
			ThisBuild / scalaVersion := "${opts.scalaVersion ?? scalaVersion}"
			ThisBuild / organization := "net.gfxmonk"
			ThisBuild / homepage := Some(url(s"https://github.com/timbertson/${opts.repo}"))
			ThisBuild / scmInfo := Some(
				ScmInfo(
					url("https://github.com/timbertson/${opts.repo}"),
					s"scm:git@github.com:timbertson/${opts.repo}.git"
				)
			)
		`)),
		new Render.CFile('project/strict.sbt', trimIndent(`
			addSbtPlugin("io.github.davidgregory084" % "sbt-tpolecat" % "0.1.20")
			${opts.strictPluginOverride ?? 'addSbtPlugin("net.gfxmonk" % "sbt-strict-scope" % "3.1.0")'}
		`)),

		new Render.CFile('project/build.properties', `sbt.version=${defaultSbtVersion}`),

		new Render.TextFile('.dockerignore', trimIndent(`
			.git
			target/
		`)),

		new Render.YAMLFile('.github/workflows/ci.yml', Workflow.ciWorkflow(
			Workflow.chores([
				{ name: 'dockerLogin', opts: { user: Workflow.expr('github.actor'), token: Workflow.secret('GITHUB_TOKEN') } },
				{ name: 'ci', opts: { docker: true } },
				{ name: 'requireClean' },
			])
		)),

		new Render.YAMLFile('.github/workflows/self-update.yml', (():Workflow.Workflow => ({
			on: {
				workflow_dispatch: {},
				schedule: [ { cron: '0 0 * * 1,4' } ],
			},
			jobs: {
				'self-update': {
					'runs-on': 'ubuntu-latest',
					steps: Workflow.chores([
						{ name: 'selfUpdate', opts: { mode: 'pr' } },
					]),
				},
			},
		}
		))())

	]
}

export default function(opts: Options) {
	const Self = {
		...dockerChores(opts),

		async release(_: {}): Promise<void> {
			run(['sbt', 'publishSigned', 'sonatypeBundleRelease'])
		},

		async requireClean(_: {}): Promise<void> {
			await git.requireClean()
		},

		async ci(opts: { docker?: boolean }): Promise<void> {
			const runTests = async () => {
				const sbtCommand = ['sbt', 'strict compile', 'test']
				if (opts.docker) {
					await Self.docker({})
					await Self.dockerRun({ args: sbtCommand })
				} else {
					await run(sbtCommand)
				}
			}

			await Promise.all([
				runTests(),
				Self.render({}),
			])
		},
		
		async selfUpdate(updateOpts: { mode?: Update.Mode, githubToken?: string }): Promise<void> {
			await Update.standardSelfUpdate({
				mode: updateOpts.mode ?? 'noop',
				commitMessage: 'chore: update',
				pr: {
					baseBranch: 'main',
					branchName: 'self-update',
					githubToken: updateOpts.githubToken,
					prTitle: '[bot] self-update',
					prBody: ':robot:',
				},
				update: (async () => {
					await Self.bump({})
					await Self.render({})
				}),
			})
		},

		async render(_: {}) {
			Render.render(files(opts))
		},

		bump,
	}
	return Self
}
