import * as Render from 'https://raw.githubusercontent.com/timbertson/chored/c918729e8dd22c26518153bdaa0437598ac0d5e3/lib/render.ts#main'
import chores from '../lib/scala.ts'

async function render(opts: {}) {
  Render.render([], {
    localDeps: {
      sources: {
        chored: '../chored'
      }
    }
  })
}
const example = chores({ repo: 'scala-example' })

export default {
	... example,
	render: {
		default: render,
		example: example.render
	}
}
